import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { savedLibraryDir } from "./config.ts";
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

export interface LibraryFunction {
  name: string;
  formula: string;
  comment: string;
  children: string[];
  allChildren: string[];
}

export interface LibraryIssue {
  file: string;
  check: string;
  message: string;
  severity: "error" | "warning";
}

export interface LibraryList {
  functions: Array<Pick<LibraryFunction, "name" | "comment" | "children" | "allChildren">>;
  errors: LibraryIssue[];
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
}

const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : undefined;
const packageRoot = moduleDir ? path.resolve(moduleDir, "..") : path.dirname(process.execPath);
const repoRoot = path.resolve(packageRoot, "..");

export function resolveLibraryDir(libraryDir?: string): string {
  const raw = libraryDir || process.env.LFM_LIBRARY_DIR || savedLibraryDir();
  let resolved: string;
  if (!raw) {
    const fallback = path.join(repoRoot, "lambda-function-library-doc", "Functions");
    if (existsSync(fallback) && statSync(fallback).isDirectory()) return fallback;
    throw new LfmError(
      'No library folder is set. Run lfm-mcp --library "D:\\path\\to\\Functions" once, or set LFM_LIBRARY_DIR.'
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
      `Library folder not found: ${resolved}. Pass --library or set LFM_LIBRARY_DIR to the Functions folder.`
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
  record: LibraryFunction | null;
  issues: LibraryIssue[];
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

  return {
    file,
    record: {
      name: body.name,
      formula: body.formula,
      comment: body.comment,
      children: body.children,
      allChildren: body.allChildren,
    },
    issues,
  };
}

function loadAll(libraryDir: string): { records: Map<string, LibraryFunction>; issues: LibraryIssue[] } {
  const records = new Map<string, LibraryFunction>();
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

function serialize(record: LibraryFunction): string {
  return `${JSON.stringify(
    {
      name: record.name,
      formula: record.formula,
      comment: record.comment,
      children: record.children,
      allChildren: record.allChildren,
    },
    null,
    2
  )}\n`;
}

function writeRecord(libraryDir: string, record: LibraryFunction): void {
  const current = existingFile(libraryDir, record.name);
  const expected = `${record.name}.json`;
  if (current && path.basename(current) !== expected) {
    throw new LfmError(
      `Library file ${path.basename(current)} differs only by case from ${expected}. Use the existing name ${path.basename(current, ".json")}.`
    );
  }
  writeFileSync(fileFor(libraryDir, record.name), serialize(record), "utf8");
}

function propagateAllChildren(records: Map<string, LibraryFunction>, start: string): LibraryFunction[] {
  const written: LibraryFunction[] = [];
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

export function listFunctions(libraryDir?: string): LibraryList {
  const dir = resolveLibraryDir(libraryDir);
  const { records, issues } = loadAll(dir);
  const functions = Array.from(records.values())
    .map(({ name, comment, children, allChildren }) => ({ name, comment, children, allChildren }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { functions, errors: issues.filter((item) => item.severity === "error") };
}

export function getFunction(name: string, libraryDir?: string): LibraryFunction {
  const dir = resolveLibraryDir(libraryDir);
  assertFunctionName(name);
  const file = existingFile(dir, name);
  if (!file) throw new LfmError(`${name}.json was not found in ${dir}.`);
  const parsed = parseFile(dir, path.basename(file));
  const errors = parsed.issues.filter((item) => item.severity === "error");
  if (!parsed.record || errors.length > 0) {
    throw new LfmError(errors.map((item) => item.message).join(" "));
  }
  if (parsed.record.name !== name) {
    throw new LfmError(`Use the name stored in the file: ${parsed.record.name}.`);
  }
  return parsed.record;
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

export function upsertFunctions(inputs: readonly LibraryInput[], libraryDir?: string): LibraryWriteResult {
  if (inputs.length === 0) {
    throw new LfmError("upsertFunctions requires at least one function.");
  }
  const dir = resolveLibraryDir(libraryDir);
  const { records } = loadAll(dir);
  const warnings: LibraryIssue[] = [];
  const written = new Map<string, LibraryFunction>();

  for (const input of inputs) {
    assertFunctionName(input.name);
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
    const record: LibraryFunction = {
      name: input.name,
      formula: input.formula,
      comment: input.comment ?? "",
      children,
      allChildren: [],
    };
    records.set(record.name, record);
    written.set(record.name, record);
  }

  const toWrite = new Map<string, LibraryFunction>();
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
    functions: Array.from(written.values()),
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
    functions.push(record);
    queue.push(...record.children);
  }

  return { functions, missing };
}
