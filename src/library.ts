import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allChildrenOf,
  findLibraryChildren,
  findUnprefixedCalls,
} from "./lambdaFormula.ts";

export class LfmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LfmError";
  }
}

export type LibraryRole = "public" | "helper";

export interface LibraryFunction {
  name: string;
  formula: string;
  comment: string;
  children: string[];
  allChildren: string[];
  /** Effective role. Missing or invalid stored values are public. */
  role: LibraryRole;
  /** Effective group. A stored override, the name prefix, or Ungrouped. */
  group: string;
  /** True only when the file stores a non-empty string group. */
  groupAssigned: boolean;
  /** Effective tags. Missing or invalid stored values are an empty array. */
  tags: string[];
}

export interface LibraryIssue {
  file: string;
  check: string;
  message: string;
  severity: "error" | "warning";
}

export interface LibraryList {
  functions: Array<
    Pick<
      LibraryFunction,
      "name" | "comment" | "children" | "allChildren" | "role" | "group" | "groupAssigned" | "tags"
    >
  >;
  errors: LibraryIssue[];
}

export interface LibraryListFilter {
  role?: string;
  group?: string;
  tag?: string;
}

export interface LibraryValidation {
  ok: boolean;
  issues: LibraryIssue[];
}

export interface LibraryWriteResult {
  functions: LibraryFunction[];
  warnings: LibraryIssue[];
  /** Other library files whose allChildren changed because of this write. */
  updated: string[];
}

export interface LibraryClosure {
  functions: LibraryFunction[];
  missing: string[];
}

export interface LibraryInput {
  name: string;
  formula: string;
  comment?: string;
  role?: LibraryRole;
  /** Stored group override. An empty string removes the stored group. */
  group?: string;
  tags?: string[];
}

interface StoredFunction extends LibraryFunction {
  /** Parsed JSON object, including unknown keys and invalid metadata. */
  source: Record<string, unknown>;
}

const metadataChecks = new Set(["role", "group", "tags"]);

const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : undefined;
const packageRoot = moduleDir ? path.resolve(moduleDir, "..") : path.dirname(process.execPath);
const repoRoot = path.resolve(packageRoot, "..");

export function resolveLibraryDir(libraryDir?: string): string {
  const raw = libraryDir || process.env.LFM_LIBRARY_DIR;
  let resolved: string;
  if (!raw) {
    const fallback = path.join(repoRoot, "lambda-function-library-doc", "Functions");
    if (existsSync(fallback) && statSync(fallback).isDirectory()) return fallback;
    throw new LfmError(
      "No library folder is set. Pass --library in the MCP server args, or set LFM_LIBRARY_DIR."
    );
  } else if (path.isAbsolute(raw)) {
    resolved = raw;
  } else {
    const fromCwd = path.resolve(process.cwd(), raw);
    const fromRepo = path.resolve(repoRoot, raw);
    resolved = existsSync(fromCwd) ? fromCwd : fromRepo;
  }

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new LfmError(
      `Library folder not found: ${resolved}. Pass --library in the MCP server args, or set LFM_LIBRARY_DIR, to the Functions folder.`
    );
  }
  return resolved;
}

function issue(
  file: string,
  check: string,
  message: string,
  severity: "error" | "warning" = "error"
): LibraryIssue {
  return { file, check, message, severity };
}

function jsonFiles(libraryDir: string): string[] {
  return readdirSync(libraryDir)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
}

function readText(filePath: string): string {
  const text = readFileSync(filePath, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(right);
  return left.every((item) => values.has(item));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function effectiveRole(value: unknown): LibraryRole {
  return value === "public" || value === "helper" ? value : "public";
}

function hasStoredGroup(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function effectiveGroup(name: string, value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const dot = name.indexOf(".");
  if (dot > 0) return name.slice(0, dot);
  return "Ungrouped";
}

function effectiveTags(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}

function syncView(record: StoredFunction): void {
  const source = record.source;
  if (typeof source.name === "string") record.name = source.name;
  if (typeof source.formula === "string") record.formula = source.formula;
  record.comment = typeof source.comment === "string" ? source.comment : "";
  record.children = isStringArray(source.children) ? source.children : [];
  record.allChildren = isStringArray(source.allChildren) ? source.allChildren : [];
  record.role = effectiveRole(source.role);
  record.group = effectiveGroup(record.name, source.group);
  record.groupAssigned = hasStoredGroup(source.group);
  record.tags = effectiveTags(source.tags);
}

function storedFrom(source: Record<string, unknown>): StoredFunction {
  const record: StoredFunction = {
    name: typeof source.name === "string" ? source.name : "",
    formula: typeof source.formula === "string" ? source.formula : "",
    comment: "",
    children: [],
    allChildren: [],
    role: "public",
    group: "Ungrouped",
    groupAssigned: false,
    tags: [],
    source,
  };
  syncView(record);
  return record;
}

function toPublic(record: StoredFunction): LibraryFunction {
  return {
    name: record.name,
    formula: record.formula,
    comment: record.comment,
    children: record.children,
    allChildren: record.allChildren,
    role: record.role,
    group: record.group,
    groupAssigned: record.groupAssigned,
    tags: record.tags,
  };
}

function assertFunctionName(name: string): void {
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new LfmError(`"${name}" cannot be used as a function name or file name.`);
  }
}

function fileFor(libraryDir: string, name: string): string {
  return path.join(libraryDir, `${name}.json`);
}

function existingFile(libraryDir: string, name: string): string | undefined {
  const target = `${name}.json`;
  const match = jsonFiles(libraryDir).find((file) => file.toLowerCase() === target.toLowerCase());
  return match ? path.join(libraryDir, match) : undefined;
}

interface ParsedFile {
  file: string;
  record: StoredFunction | null;
  issues: LibraryIssue[];
}

function metadataIssues(file: string, body: Record<string, unknown>): LibraryIssue[] {
  const issues: LibraryIssue[] = [];
  if ("role" in body && body.role !== "public" && body.role !== "helper") {
    issues.push(issue(file, "role", `${file} role must be "public" or "helper".`));
  }
  if ("group" in body && (typeof body.group !== "string" || body.group.trim().length === 0)) {
    issues.push(issue(file, "group", `${file} group must be a non-empty string.`));
  }
  if ("tags" in body && !isStringArray(body.tags)) {
    issues.push(issue(file, "tags", `${file} tags must be an array of strings.`));
  }
  return issues;
}

function parseFile(libraryDir: string, file: string): ParsedFile {
  const filePath = path.join(libraryDir, file);
  const stem = file.slice(0, -".json".length);
  const text = readText(filePath);
  if (text.trim() === "") {
    return { file, record: null, issues: [issue(file, "empty", `${file} is empty.`)] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { file, record: null, issues: [issue(file, "json", `${file} is not JSON: ${message}`)] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { file, record: null, issues: [issue(file, "json", `${file} must be a JSON object.`)] };
  }

  const body = parsed as Record<string, unknown>;
  const issues: LibraryIssue[] = [];
  const required = ["name", "formula", "comment", "children", "allChildren"] as const;
  for (const field of required) {
    if (!(field in body)) {
      issues.push(issue(file, "fields", `${file} lacks ${field}.`));
    }
  }
  if (issues.length > 0) {
    return { file, record: null, issues };
  }

  if (typeof body.name !== "string" || body.name !== stem) {
    issues.push(issue(file, "filename", `${file} stem is different from name ${String(body.name)}.`));
  }
  if (typeof body.formula !== "string" || !body.formula.startsWith("=LAMBDA")) {
    issues.push(issue(file, "formula", `${file} formula does not start with =LAMBDA.`));
  }
  if (typeof body.comment !== "string") {
    issues.push(issue(file, "fields", `${file} comment must be a string.`));
  }
  if (!isStringArray(body.children)) {
    issues.push(issue(file, "fields", `${file} children must be an array of strings.`));
  }
  if (!isStringArray(body.allChildren)) {
    issues.push(issue(file, "fields", `${file} allChildren must be an array of strings.`));
  }
  if (issues.some((item) => item.severity === "error" && item.check === "fields")) {
    return { file, record: null, issues };
  }
  if (typeof body.name !== "string" || typeof body.formula !== "string" || typeof body.comment !== "string") {
    return { file, record: null, issues };
  }
  if (!isStringArray(body.children) || !isStringArray(body.allChildren)) {
    return { file, record: null, issues };
  }

  issues.push(...metadataIssues(file, body));

  const refs = findLibraryChildren(body.formula, body.name);
  const childSet = new Set(body.children);
  for (const ref of refs) {
    if (!childSet.has(ref)) {
      issues.push(
        issue(file, "ref-missing-from-children", `${file} contains {ref}${ref}( which is missing from children.`)
      );
    }
  }
  const refSet = new Set(refs);
  for (const child of body.children) {
    if (!refSet.has(child)) {
      issues.push(
        issue(
          file,
          "child-missing-from-formula",
          `${file} lists ${child} in children, and the formula has no {ref}${child}(.`
        )
      );
    }
  }

  return { file, record: storedFrom(body), issues };
}

function loadAll(libraryDir: string): { records: Map<string, StoredFunction>; issues: LibraryIssue[] } {
  const records = new Map<string, StoredFunction>();
  const issues: LibraryIssue[] = [];
  for (const file of jsonFiles(libraryDir)) {
    const parsed = parseFile(libraryDir, file);
    issues.push(...parsed.issues);
    if (parsed.record && !records.has(parsed.record.name)) {
      records.set(parsed.record.name, parsed.record);
    }
  }
  return { records, issues };
}

function missingChildWarnings(record: LibraryFunction, known: ReadonlyMap<string, LibraryFunction>): LibraryIssue[] {
  const file = `${record.name}.json`;
  return record.children
    .filter((child) => !known.has(child))
    .map((child) =>
      issue(file, "missing-from-library", `${record.name} calls {ref}${child}(, and ${child}.json is not in the library.`, "warning")
    );
}

function serialize(record: StoredFunction): string {
  return `${JSON.stringify(record.source, null, 2)}\n`;
}

function writeRecord(libraryDir: string, record: StoredFunction): void {
  const current = existingFile(libraryDir, record.name);
  const expected = `${record.name}.json`;
  if (current && path.basename(current) !== expected) {
    throw new LfmError(
      `Library file ${path.basename(current)} differs only by case from ${expected}. Use the existing name ${path.basename(current, ".json")}.`
    );
  }
  writeFileSync(fileFor(libraryDir, record.name), serialize(record), "utf8");
}

function propagateAllChildren(records: Map<string, StoredFunction>, start: string): StoredFunction[] {
  const written: StoredFunction[] = [];
  const queue = [start];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const record = records.get(current);
    if (!record) continue;

    const nextAll = allChildrenOf(current, (name) => records.get(name)?.children);
    const changed = !sameSet(record.allChildren, nextAll);
    if (changed) {
      record.allChildren = nextAll;
      record.source.allChildren = nextAll;
      written.push(record);
    }
    if (current === start || changed) {
      for (const other of records.values()) {
        if (other.children.includes(current)) queue.push(other.name);
      }
    }
  }

  return written;
}

function matchesFilter(record: LibraryFunction, filter: LibraryListFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.role !== undefined && record.role !== filter.role) return false;
  if (filter.group !== undefined && record.group !== filter.group) return false;
  if (filter.tag !== undefined && !record.tags.includes(filter.tag)) return false;
  return true;
}

export function listFunctions(libraryDir?: string, filter?: LibraryListFilter): LibraryList {
  if (filter?.role !== undefined && filter.role !== "public" && filter.role !== "helper") {
    throw new LfmError('Role filter must be "public" or "helper".');
  }
  const dir = resolveLibraryDir(libraryDir);
  const { records, issues } = loadAll(dir);
  const functions = Array.from(records.values())
    .map((record) => {
      const pub = toPublic(record);
      return {
        name: pub.name,
        comment: pub.comment,
        children: pub.children,
        allChildren: pub.allChildren,
        role: pub.role,
        group: pub.group,
        groupAssigned: pub.groupAssigned,
        tags: pub.tags,
      };
    })
    .filter((record) => matchesFilter(record, filter))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { functions, errors: issues.filter((item) => item.severity === "error") };
}

export function getFunction(name: string, libraryDir?: string): LibraryFunction {
  const dir = resolveLibraryDir(libraryDir);
  assertFunctionName(name);
  const file = existingFile(dir, name);
  if (!file) throw new LfmError(`${name}.json was not found in ${dir}.`);
  const parsed = parseFile(dir, path.basename(file));
  const blocking = parsed.issues.filter((item) => item.severity === "error" && !metadataChecks.has(item.check));
  if (!parsed.record || blocking.length > 0) {
    const messages = (blocking.length > 0 ? blocking : parsed.issues).map((item) => item.message);
    throw new LfmError(messages.join(" ") || `${name}.json could not be read.`);
  }
  if (parsed.record.name !== name) {
    throw new LfmError(`Use the name stored in the file: ${parsed.record.name}.`);
  }
  return toPublic(parsed.record);
}

export function validateLibrary(libraryDir?: string, names?: readonly string[]): LibraryValidation {
  const dir = resolveLibraryDir(libraryDir);
  const { records, issues } = loadAll(dir);
  const selected = names && names.length > 0 ? new Set(names) : null;
  const relevant = issues.filter((item) => !selected || selected.has(item.file.replace(/\.json$/i, "")));
  for (const record of records.values()) {
    if (selected && !selected.has(record.name)) continue;
    relevant.push(...missingChildWarnings(record, records));
  }
  return { ok: relevant.every((item) => item.severity !== "error"), issues: relevant };
}

function assertMetadataInput(input: LibraryInput): void {
  if (input.role !== undefined && input.role !== "public" && input.role !== "helper") {
    throw new LfmError(`${input.name} role must be "public" or "helper".`);
  }
  if (input.group !== undefined && typeof input.group !== "string") {
    throw new LfmError(`${input.name} group must be a string.`);
  }
  if (input.tags !== undefined && !isStringArray(input.tags)) {
    throw new LfmError(`${input.name} tags must be an array of strings.`);
  }
}

function applyInput(record: StoredFunction, input: LibraryInput, children: string[]): void {
  record.source.formula = input.formula;
  record.source.children = children;
  if (input.comment !== undefined) record.source.comment = input.comment;
  if (input.role !== undefined) record.source.role = input.role;
  if (input.group !== undefined) {
    if (input.group.trim() === "") delete record.source.group;
    else record.source.group = input.group;
  }
  if (input.tags !== undefined) record.source.tags = input.tags.slice();
  syncView(record);
}

function createRecord(input: LibraryInput, children: string[]): StoredFunction {
  const source: Record<string, unknown> = {
    name: input.name,
    formula: input.formula,
    comment: input.comment ?? "",
    children,
    allChildren: [],
  };
  if (input.role !== undefined) source.role = input.role;
  if (input.group !== undefined && input.group.trim() !== "") source.group = input.group;
  if (input.tags !== undefined) source.tags = input.tags.slice();
  return storedFrom(source);
}

export function upsertFunctions(inputs: readonly LibraryInput[], libraryDir?: string): LibraryWriteResult {
  if (inputs.length === 0) {
    throw new LfmError("upsertFunctions requires at least one function.");
  }
  const dir = resolveLibraryDir(libraryDir);
  const { records } = loadAll(dir);
  const warnings: LibraryIssue[] = [];
  const written = new Map<string, StoredFunction>();

  for (const input of inputs) {
    assertFunctionName(input.name);
    assertMetadataInput(input);
    if (typeof input.formula !== "string" || !input.formula.startsWith("=LAMBDA")) {
      throw new LfmError(`${input.name} formula must start with =LAMBDA.`);
    }
    const known = Array.from(records.keys()).filter((name) => name !== input.name);
    const bare = findUnprefixedCalls(input.formula, input.name, known);
    if (bare.length > 0) {
      throw new LfmError(
        `${input.name} calls ${bare.join(", ")} without {ref}. Write each child as {ref}Name(.`
      );
    }

    const children = findLibraryChildren(input.formula, input.name);
    const existing = records.get(input.name);
    const record = existing ?? createRecord(input, children);
    if (existing) applyInput(existing, input, children);
    records.set(record.name, record);
    written.set(record.name, record);
  }

  const toWrite = new Map<string, StoredFunction>();
  for (const name of written.keys()) {
    for (const record of propagateAllChildren(records, name)) {
      toWrite.set(record.name, record);
    }
    const start = records.get(name);
    if (start) toWrite.set(start.name, start);
  }

  for (const record of toWrite.values()) {
    writeRecord(dir, record);
    warnings.push(...missingChildWarnings(record, records));
  }

  return {
    functions: Array.from(written.values()).map(toPublic),
    warnings,
    updated: Array.from(toWrite.keys()).filter((name) => !written.has(name)),
  };
}

export function upsertFunction(input: LibraryInput, libraryDir?: string): LibraryWriteResult {
  return upsertFunctions([input], libraryDir);
}

export function deleteFunction(name: string, libraryDir?: string): { name: string; file: string } {
  const dir = resolveLibraryDir(libraryDir);
  assertFunctionName(name);
  const file = existingFile(dir, name);
  if (!file) throw new LfmError(`${name}.json was not found in ${dir}.`);
  if (path.basename(file) !== `${name}.json`) {
    throw new LfmError(`Use the name stored in the file: ${path.basename(file, ".json")}.`);
  }
  unlinkSync(file);
  return { name, file };
}

export function libraryClosure(names: readonly string[], libraryDir?: string): LibraryClosure {
  if (names.length === 0) {
    throw new LfmError("libraryClosure requires at least one function name.");
  }
  const dir = resolveLibraryDir(libraryDir);
  const { records } = loadAll(dir);
  const functions: LibraryFunction[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue = [...names];

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const record = records.get(name);
    if (!record) {
      missing.push(name);
      continue;
    }
    functions.push(toPublic(record));
    queue.push(...record.children);
  }

  return { functions, missing };
}
