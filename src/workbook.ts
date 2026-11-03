import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findChildNamedItems,
  toExcelFormula,
  toLibraryFormula,
  type NamedItemScope,
} from "./lambdaFormula.ts";
import { loadExcelNamesScript } from "./excelScript.ts";
import {
  LfmError,
  libraryClosure,
  upsertFunctions,
  type LibraryFunction,
  type LibraryIssue,
  type LibraryWriteResult,
} from "./library.ts";

export interface WorkbookLambda {
  name: string;
  formula: string;
  comment: string;
  scope: NamedItemScope;
  sheet: string | null;
}

export interface WorkbookNameFailure {
  name: string;
  message: string;
}

export interface WorkbookImportResult {
  imported: string[];
  failed: WorkbookNameFailure[];
  missing: string[];
  formulas: Array<{ name: string; formula: string; comment: string; scope: NamedItemScope; sheet: string | null }>;
}

export interface WorkbookExportResult extends LibraryWriteResult {
  missing: string[];
}

interface ExcelCommandResult {
  ok: boolean;
  message?: string;
  names: WorkbookLambda[];
  imported: string[];
  failed: WorkbookNameFailure[];
}

function assertWorkbookPath(workbookPath: string): string {
  const resolved = path.resolve(workbookPath);
  if (!existsSync(resolved)) {
    throw new LfmError(`Workbook not found: ${resolved}`);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== ".xlsx" && extension !== ".xlsm") {
    throw new LfmError(`LAMBDA names need an .xlsx or .xlsm file. Got ${extension || "no extension"}.`);
  }
  return resolved;
}

function runExcel(scriptPath: string, commandPath: string, resultPath: string): Promise<ExcelCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-CommandPath", commandPath, "-ResultPath", resultPath],
      { windowsHide: true }
    );
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (!existsSync(resultPath)) {
        reject(new LfmError(stderr.trim() || "Excel finished without a result. powershell.exe may be unavailable."));
        return;
      }
      readFile(resultPath, "utf8")
        .then((text) => {
          const parsed = JSON.parse(text) as ExcelCommandResult;
          if (!parsed.ok) {
            const imported = (parsed.imported ?? []).join(", ") || "none";
            const detail = parsed.message || "Excel command failed.";
            reject(new LfmError(`${detail} Imported: ${imported}.`));
            return;
          }
          resolve(parsed);
        })
        .catch((readError: unknown) => {
          reject(readError instanceof Error ? readError : new LfmError(String(readError)));
        });
    };

    timer = setTimeout(() => {
      child.kill();
      finish(new LfmError("Excel did not finish within 120 seconds. Close any dialog Excel opened for this file."));
    }, 120_000);
    child.on("error", (error) => finish(new LfmError(error.message)));
    child.on("exit", () => finish());
  });
}

async function excelCommand(body: Record<string, unknown>): Promise<ExcelCommandResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "lfm-excel-"));
  const scriptPath = path.join(dir, "excel-names.ps1");
  const commandPath = path.join(dir, "command.json");
  const resultPath = path.join(dir, "result.json");
  await writeFile(scriptPath, await loadExcelNamesScript(), "utf8");
  await writeFile(commandPath, JSON.stringify(body), "utf8");
  try {
    return await runExcel(scriptPath, commandPath, resultPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function normalizeDefinedNameFormula(formula: string): string {
  return formula.replace(/^=_xlfn\.LAMBDA/i, "=LAMBDA").replaceAll("_xlpm.", "");
}

export async function listWorkbookLambdas(workbookPath: string): Promise<WorkbookLambda[]> {
  const resolved = assertWorkbookPath(workbookPath);
  const result = await excelCommand({ action: "list", workbookPath: resolved });
  return (result.names ?? []).map((lambda) => ({
    ...lambda,
    formula: normalizeDefinedNameFormula(lambda.formula || ""),
    comment: lambda.comment || "",
    sheet: lambda.sheet ?? null,
  }));
}

function orderForImport(functions: readonly LibraryFunction[]): LibraryFunction[] {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const ordered: LibraryFunction[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (fn: LibraryFunction): void => {
    if (done.has(fn.name) || visiting.has(fn.name)) return;
    visiting.add(fn.name);
    for (const child of fn.children) {
      const dependency = byName.get(child);
      if (dependency) visit(dependency);
    }
    visiting.delete(fn.name);
    done.add(fn.name);
    ordered.push(fn);
  };

  for (const fn of functions) visit(fn);
  return ordered;
}

export async function importToWorkbook(options: {
  workbookPath: string;
  names: readonly string[];
  scope: NamedItemScope;
  sheet?: string;
  libraryDir?: string;
}): Promise<WorkbookImportResult> {
  if (options.names.length === 0) {
    throw new LfmError("importToWorkbook requires at least one function name.");
  }
  if (options.scope === "Worksheet" && !options.sheet) {
    throw new LfmError("Worksheet scope requires a sheet name.");
  }
  const workbookPath = assertWorkbookPath(options.workbookPath);
  const closure = libraryClosure(options.names, options.libraryDir);
  if (closure.functions.length === 0) {
    throw new LfmError(`None of the requested functions are in the library: ${options.names.join(", ")}.`);
  }

  const formulas = orderForImport(closure.functions).map((fn) => ({
    name: fn.name,
    formula: toExcelFormula(fn.formula, options.scope, options.sheet ?? ""),
    comment: fn.comment,
    scope: options.scope,
    sheet: options.scope === "Worksheet" ? options.sheet ?? null : null,
  }));

  const result = await excelCommand({
    action: "write",
    workbookPath,
    items: formulas,
  });

  return {
    imported: result.imported ?? [],
    failed: result.failed ?? [],
    missing: closure.missing,
    formulas,
  };
}

export async function exportFromWorkbook(options: {
  workbookPath: string;
  names?: readonly string[];
  sheet?: string;
  libraryDir?: string;
}): Promise<WorkbookExportResult> {
  const lambdas = await listWorkbookLambdas(options.workbookPath);
  const byName = new Map(lambdas.map((lambda) => [lambda.name.toLowerCase(), lambda]));
  const workbookNames = lambdas.filter((lambda) => lambda.scope === "Workbook").map((lambda) => lambda.name);

  const childrenOf = new Map<string, string[]>();
  for (const lambda of lambdas) {
    childrenOf.set(
      lambda.name,
      findChildNamedItems(lambda.formula, lambda.name, workbookNames)
    );
  }

  const selected: WorkbookLambda[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];

  if (!options.names || options.names.length === 0) {
    queue.push(...lambdas.map((lambda) => lambda.name));
  } else {
    for (const requested of options.names) {
      const found = byName.get(requested.toLowerCase());
      if (!found) missing.push(requested);
      else queue.push(found.name);
    }
  }

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    const lambda = lambdas.find((item) => item.name === name);
    if (!lambda) continue;
    seen.add(name);
    selected.push(lambda);
    for (const child of childrenOf.get(name) ?? []) queue.push(child);
  }

  if (selected.length === 0) {
    throw new LfmError(
      missing.length > 0
        ? `None of the requested names are LAMBDA defined names: ${missing.join(", ")}.`
        : "The workbook has no LAMBDA defined names."
    );
  }

  const inputs = selected.map((lambda) => {
    const sheetName = lambda.scope === "Worksheet" ? lambda.sheet || "" : options.sheet || "";
    const children = childrenOf.get(lambda.name) ?? [];
    return {
      name: lambda.name,
      formula: toLibraryFormula(lambda.formula, sheetName, children),
      comment: lambda.comment,
    };
  });

  const written = upsertFunctions(inputs, options.libraryDir);
  const warnings: LibraryIssue[] = [...written.warnings];
  for (const requested of missing) {
    warnings.push({
      file: `${requested}.json`,
      check: "missing-from-workbook",
      message: `${requested} is not a LAMBDA defined name in the workbook.`,
      severity: "warning",
    });
  }

  return { ...written, warnings, missing };
}
