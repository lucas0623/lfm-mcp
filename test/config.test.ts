import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readCli, useLibrary } from "../src/config.ts";
import { resolveLibraryDir } from "../src/library.ts";

const home = mkdtempSync(path.join(tmpdir(), "lfm-config-"));
const previousLibrary = process.env.LFM_LIBRARY_DIR;

after(() => {
  if (previousLibrary === undefined) delete process.env.LFM_LIBRARY_DIR;
  else process.env.LFM_LIBRARY_DIR = previousLibrary;
  rmSync(home, { recursive: true, force: true });
});

describe("library location", () => {
  it("uses --library for this process and does not save a config file", () => {
    const folder = path.join(home, "Functions");
    mkdirSync(folder);
    delete process.env.LFM_LIBRARY_DIR;
    assert.equal(readCli(["--library", folder]).library, folder);
    assert.equal(useLibrary(folder), path.resolve(folder));
    assert.equal(process.env.LFM_LIBRARY_DIR, path.resolve(folder));
    assert.equal(existsSync(path.join(home, "lfm-mcp", "config.json")), false);
    assert.equal(resolveLibraryDir(), path.resolve(folder));
  });

  it("rejects a missing --library folder", () => {
    assert.throws(() => useLibrary(path.join(home, "missing")), /Library folder not found/);
  });
});
