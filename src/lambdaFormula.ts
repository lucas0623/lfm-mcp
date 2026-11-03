/**
 * Lambda formula rules used by the task pane and by lfm-api.
 * A stored library formula calls children as {ref}Name(.
 * An Excel formula calls them as Sheet!Name( or, at workbook scope, Name(.
 */

export type NamedItemScope = "Workbook" | "Worksheet";

const NAME_PATTERN = "[A-Za-z_\\u0080-\\uFFFF\\\\][A-Za-z0-9_\\u0080-\\uFFFF.\\\\]*";

/**
 * Blank out Excel string literals so a "!" inside quotes is not read as a sheet qualifier.
 * Doubled quotes ("") are an escaped quote and stay inside the literal.
 */
function maskExcelStringLiterals(formula: string): string {
  let out = "";
  let i = 0;
  while (i < formula.length) {
    if (formula[i] !== '"') {
      out += formula[i];
      i++;
      continue;
    }
    out += " ";
    i++;
    while (i < formula.length) {
      if (formula[i] === '"') {
        if (formula[i + 1] === '"') {
          out += "  ";
          i += 2;
          continue;
        }
        out += " ";
        i++;
        break;
      }
      out += formula[i] === "\n" ? "\n" : " ";
      i++;
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function callsNamedItem(formula: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  return new RegExp(`(?<![A-Za-z0-9_.\\u0080-\\uFFFF\\\\])${escaped}\\(`).test(formula);
}

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  if (!search) return input;
  return input.split(search).join(replacement);
}

/**
 * Direct child names called by an Excel formula.
 * Worksheet-scoped calls are Sheet!Name(. Workbook-scoped calls are Name( for a known workbook name.
 * A "!" inside a string is ignored.
 */
export function findChildNamedItems(
  formula: string,
  selfName: string,
  workbookNames: readonly string[]
): string[] {
  const scanned = maskExcelStringLiterals(formula || "");
  const children = new Set<string>();
  const worksheetCall = new RegExp(`!(${NAME_PATTERN})\\(`, "g");

  let match: RegExpExecArray | null;
  while ((match = worksheetCall.exec(scanned)) !== null) {
    const name = match[1];
    if (name && name !== selfName) {
      children.add(name);
    }
  }

  for (const wbFunc of workbookNames) {
    if (wbFunc && wbFunc !== selfName && callsNamedItem(scanned, wbFunc)) {
      children.add(wbFunc);
    }
  }

  return Array.from(children);
}

/** Direct child names in a library formula, in order of first {ref}Name( appearance. */
export function findLibraryChildren(formula: string, selfName: string): string[] {
  const scanned = maskExcelStringLiterals(formula || "");
  const children: string[] = [];
  const seen = new Set<string>();
  const refCall = new RegExp(`\\{ref\\}(${NAME_PATTERN})\\(`, "g");

  let match: RegExpExecArray | null;
  while ((match = refCall.exec(scanned)) !== null) {
    const name = match[1];
    if (!name || name === selfName || seen.has(name)) continue;
    seen.add(name);
    children.push(name);
  }

  return children;
}

/**
 * Calls that still use Excel form (Sheet!Name( or a known Name() without {ref}).
 * {ref}Name( is not included.
 */
export function findUnprefixedCalls(
  formula: string,
  selfName: string,
  knownNames: readonly string[]
): string[] {
  const prefixed = new Set(findLibraryChildren(formula, selfName));
  return findChildNamedItems(formula, selfName, knownNames).filter((name) => !prefixed.has(name));
}

/** Replace the sheet prefix, then mark each child call with {ref}. */
export function toLibraryFormula(
  formula: string,
  sheetName: string,
  childNames: readonly string[]
): string {
  let next = formula || "";
  if (sheetName) {
    const prefix = sheetName.includes(" ") ? `'${sheetName}'!` : `${sheetName}!`;
    next = replaceAllLiteral(next, prefix, "{ref}");
  }

  for (const childName of childNames) {
    if (!childName) continue;
    const pattern = new RegExp(`(?<!\\{ref\\})\\b${escapeRegExp(childName)}\\(`, "g");
    next = next.replace(pattern, `{ref}${childName}(`);
  }

  return next;
}

/** Expand {ref} to a worksheet prefix, or remove it for workbook scope. */
export function toExcelFormula(
  formula: string,
  scope: NamedItemScope,
  sheetName = ""
): string {
  const source = formula || "";
  if (scope === "Worksheet") {
    if (!sheetName) {
      throw new Error("Worksheet scope requires a sheet name.");
    }
    const escapedName = sheetName.replace(/'/g, "''");
    const worksheetRef = sheetName.includes(" ") ? `'${escapedName}'!` : `${escapedName}!`;
    return source.replace(/\{ref\}/g, worksheetRef);
  }
  return source.replace(/\{ref\}/g, "");
}

/**
 * Direct children first, then further descendants, each name once.
 * Unknown names stay in the list and are not walked.
 */
export function allChildrenOf(
  name: string,
  childrenOf: (name: string) => readonly string[] | undefined
): string[] {
  const result: string[] = [];
  const seen = new Set<string>([name]);
  const queue = [...(childrenOf(name) ?? [])];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    const nested = childrenOf(next);
    if (nested) queue.push(...nested);
  }

  return result;
}
