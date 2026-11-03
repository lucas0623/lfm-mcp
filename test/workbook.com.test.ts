import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { exportFromWorkbook, getFunction, importToWorkbook, listWorkbookLambdas, upsertFunction } from "../src/index.ts";

const root = mkdtempSync(path.join(tmpdir(), "lfm-com-"));
const libraryDir = path.join(root, "library");
const exportedDir = path.join(root, "exported");
const workbookPath = path.join(root, "sample.xlsx");

function createWorkbook(filePath: string): void {
  const psPath = filePath.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $wb = $excel.Workbooks.Add()
  $wb.SaveAs('${psPath}', 51)
  $wb.Close($false)
} finally {
  if ($excel) { $excel.Quit() }
}
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0 || !existsSync(filePath)) {
    throw new Error(result.stderr || result.stdout || `Excel did not create ${filePath}`);
  }
}

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Excel COM import and export", () => {
  it("writes library functions into a workbook and reads them back", async () => {
    mkdirSync(libraryDir);
    mkdirSync(exportedDir);
    upsertFunction(
      {
        name: "Dist",
        formula: "=LAMBDA(xi,yi,xj,yj,SQRT((xj-xi)^2+(yj-yi)^2))",
        comment: "Distance",
      },
      libraryDir
    );
    upsertFunction(
      {
        name: "UseDist",
        formula: "=LAMBDA(xi,yi,xj,yj,{ref}Dist(xi,yi,xj,yj)*2)",
        comment: "Twice the distance",
      },
      libraryDir
    );
    createWorkbook(workbookPath);

    const imported = await importToWorkbook({
      workbookPath,
      names: ["UseDist"],
      scope: "Workbook",
      libraryDir,
    });
    assert.deepEqual(imported.imported, ["Dist", "UseDist"], JSON.stringify(imported));
    assert.deepEqual(imported.failed, []);
    assert.equal(imported.formulas.find((fn) => fn.name === "UseDist")?.formula.includes("{ref}"), false);

    const listed = await listWorkbookLambdas(workbookPath);
    const useDist = listed.find((fn) => fn.name === "UseDist");
    assert.ok(useDist);
    assert.equal(useDist.scope, "Workbook");
    assert.match(useDist.formula, /=LAMBDA/i);
    assert.match(useDist.formula, /Dist\(/);
    assert.equal(useDist.comment, "Twice the distance");

    const exported = await exportFromWorkbook({
      workbookPath,
      names: ["UseDist"],
      libraryDir: exportedDir,
    });
    assert.deepEqual(
      exported.functions.map((fn) => fn.name).sort(),
      ["Dist", "UseDist"]
    );
    const stored = getFunction("UseDist", exportedDir);
    assert.match(stored.formula, /\{ref\}Dist\(/);
    assert.deepEqual(stored.children, ["Dist"]);
    assert.deepEqual(stored.allChildren, ["Dist"]);

    const onSheet = await importToWorkbook({
      workbookPath,
      names: ["Dist"],
      scope: "Worksheet",
      sheet: "Sheet1",
      libraryDir,
    });
    assert.deepEqual(onSheet.failed, [], JSON.stringify(onSheet.failed));
    assert.deepEqual(onSheet.imported, ["Dist"]);
    const sheetDist = (await listWorkbookLambdas(workbookPath)).find(
      (fn) => fn.name === "Dist" && fn.scope === "Worksheet"
    );
    assert.equal(sheetDist?.sheet, "Sheet1");
    assert.match(sheetDist?.formula ?? "", /=LAMBDA/i);
  });
});
