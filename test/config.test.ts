import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { readCli, readConfig, rememberLibrary } from "../src/config.ts";
import { listFunctions, resolveLibraryDir } from "../src/library.ts";

const home = mkdtempSync(path.join(tmpdir(), "lfm-config-"));
const previousLocal = process.env.LOCALAPPDATA;
const previousLibrary = process.env.LFM_LIBRARY_DIR;

function useTempHome(): void {
  process.env.LOCALAPPDATA = home;
  delete process.env.LFM_LIBRARY_DIR;
}

afterEach(() => {
  if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocal;
  if (previousLibrary === undefined) delete process.env.LFM_LIBRARY_DIR;
  else process.env.LFM_LIBRARY_DIR = previousLibrary;
});

describe("library location", () => {
  it("saves --library and reads that folder next time", () => {
    useTempHome();
    const folder = path.join(home, "Functions");
    mkdirSync(folder);
    assert.equal(readCli(["--library", folder]).library, folder);
    assert.equal(rememberLibrary(folder), path.resolve(folder));
    delete process.env.LFM_LIBRARY_DIR;
    assert.equal(readConfig().libraryDir, path.resolve(folder));
    assert.equal(resolveLibraryDir(), path.resolve(folder));
    assert.deepEqual(listFunctions().functions, []);
  });

  it("rejects a missing --library folder", () => {
    useTempHome();
    assert.throws(() => rememberLibrary(path.join(home, "missing")), /Library folder not found/);
  });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});
