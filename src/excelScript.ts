import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LfmError } from "./library.ts";

/** The PowerShell Excel bridge. Dev reads the file beside this module. The executable embeds it. */
export async function loadExcelNamesScript(): Promise<string> {
  if (import.meta.url) {
    const beside = path.join(path.dirname(fileURLToPath(import.meta.url)), "excel-names.ps1");
    if (existsSync(beside)) return readFileSync(beside, "utf8");
  }
  try {
    const embedded = await import("excel-names-script");
    if (embedded.embeddedExcelNamesScript) return embedded.embeddedExcelNamesScript;
  } catch {
    // A source checkout always hits the file above.
  }
  throw new LfmError("excel-names.ps1 is missing from this build.");
}
