import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

describe("Excel COM import and export", { concurrency: 1 }, () => {
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
    assert.equal(imported.attached, false);
    assert.equal(imported.saved, true);
    assert.equal(imported.formulas.find((fn) => fn.name === "UseDist")?.formula.includes("{ref}"), false);

    const listed = await listWorkbookLambdas(workbookPath);
    const useDist = listed.names.find((fn) => fn.name === "UseDist");
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
    const sheetDist = (await listWorkbookLambdas(workbookPath)).names.find(
      (fn) => fn.name === "Dist" && fn.scope === "Worksheet"
    );
    assert.equal(sheetDist?.sheet, "Sheet1");
    assert.match(sheetDist?.formula ?? "", /=LAMBDA/i);
  });

  it("updates a workbook that is already open in Excel", async () => {
    const openPath = path.join(root, "open.xlsx");
    const readyFile = path.join(root, "ready.txt");
    const doneFile = path.join(root, "done.txt");
    const probeFile = path.join(root, "probe.json");
    mkdirSync(libraryDir, { recursive: true });
    upsertFunction(
      {
        name: "Dist",
        formula: "=LAMBDA(xi,yi,xj,yj,SQRT((xj-xi)^2+(yj-yi)^2))",
        comment: "Distance",
      },
      libraryDir
    );
    createWorkbook(openPath);

    const countBefore = excelProcessCount();
    const child = holdWorkbookOpen(openPath, readyFile, doneFile, probeFile);
    try {
      await waitForFile(readyFile);
      const imported = await importToWorkbook({
        workbookPath: openPath,
        names: ["Dist"],
        scope: "Workbook",
        libraryDir,
      });
      assert.equal(imported.attached, true, JSON.stringify(imported));
      assert.equal(imported.saved, true);
      assert.deepEqual(imported.imported, ["Dist"]);

      const listed = await listWorkbookLambdas(openPath);
      assert.equal(listed.attached, true);
      assert.ok(listed.names.some((fn) => fn.name === "Dist"));

      if (countBefore === 0) {
        const active = await listWorkbookLambdas("active");
        assert.equal(active.attached, true);
        assert.ok(active.names.some((fn) => fn.name === "Dist"));
      }
    } finally {
      writeFileSync(doneFile, "done");
      await waitForExit(child);
    }

    const probe = JSON.parse(readFileSync(probeFile, "utf8")) as { names?: string[] };
    assert.ok(probe.names?.some((name) => name === "Dist" || name.endsWith("!Dist")), JSON.stringify(probe));

    const closed = await listWorkbookLambdas(openPath);
    assert.equal(closed.attached, false);
    assert.ok(closed.names.some((fn) => fn.name === "Dist"));
  });
});

function excelProcessCount(): number {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "(Get-Process excel -ErrorAction SilentlyContinue | Measure-Object).Count"],
    { encoding: "utf8", windowsHide: true }
  );
  return Number(String(result.stdout ?? "").trim() || "0");
}

function holdWorkbookOpen(filePath: string, readyFile: string, doneFile: string, probeFile: string): ChildProcess {
  const quote = (value: string) => value.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open('${quote(filePath)}')
Set-Content -LiteralPath '${quote(readyFile)}' -Value 'ready'
$deadline = (Get-Date).AddSeconds(150)
while (-not (Test-Path -LiteralPath '${quote(doneFile)}')) {
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Milliseconds 200
}
$found = @()
$count = $wb.Names.Count
for ($i = 1; $i -le $count; $i++) {
  $found += [string]$wb.Names.Item($i).Name
}
[System.IO.File]::WriteAllText('${quote(probeFile)}', (@{ names = @($found) } | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
$wb.Close($false)
$excel.Quit()
`;
  return spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
