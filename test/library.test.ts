import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  deleteFunction,
  getFunction,
  libraryClosure,
  listFunctions,
  upsertFunction,
  validateLibrary,
} from "../src/index.ts";

const libraryDir = mkdtempSync(path.join(tmpdir(), "lfm-library-"));
const realLibrary = path.resolve(
  import.meta.dirname,
  "../../lambda-function-library-doc/Functions"
);

after(() => {
  rmSync(libraryDir, { recursive: true, force: true });
});

describe("library files", () => {
  it("writes children from {ref} calls and fills allChildren for callers", () => {
    upsertFunction(
      {
        name: "A",
        formula: "=LAMBDA(x,{ref}B(x))",
        comment: "calls B",
      },
      libraryDir
    );
    const wroteB = upsertFunction(
      {
        name: "B",
        formula: "=LAMBDA(x,{ref}C(x))",
        comment: "calls C",
      },
      libraryDir
    );
    upsertFunction({ name: "C", formula: "=LAMBDA(x,x)", comment: "leaf" }, libraryDir);

    assert.deepEqual(wroteB.updated, ["A"]);
    assert.deepEqual(getFunction("A", libraryDir).allChildren, ["B", "C"]);
    assert.deepEqual(getFunction("B", libraryDir).children, ["C"]);
    assert.deepEqual(getFunction("B", libraryDir).allChildren, ["C"]);

    const closure = libraryClosure(["A"], libraryDir);
    assert.deepEqual(
      closure.functions.map((fn) => fn.name),
      ["A", "B", "C"]
    );
    assert.deepEqual(closure.missing, []);
    assert.deepEqual(
      listFunctions(libraryDir).functions.map((fn) => fn.name),
      ["A", "B", "C"]
    );
    assert.equal(deleteFunction("C", libraryDir).name, "C");
    assert.throws(() => getFunction("C", libraryDir), /not found/);
  });

  it("rejects a sheet-qualified call", () => {
    assert.throws(
      () => upsertFunction({ name: "Bad", formula: "=LAMBDA(x,Sheet1!A(x))", comment: "" }, libraryDir),
      /without \{ref\}/
    );
  });

  it("rejects a known library call that is missing {ref}", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lfm-bare-"));
    try {
      upsertFunction({ name: "C", formula: "=LAMBDA(x,x)", comment: "" }, dir);
      assert.throws(
        () => upsertFunction({ name: "Bare", formula: "=LAMBDA(x,C(x))", comment: "" }, dir),
        /without \{ref\}/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a filename that does not match the stored name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lfm-mismatch-"));
    try {
      writeFileSync(
        path.join(dir, "Dist.json"),
        `${JSON.stringify({ name: "Other", formula: "=LAMBDA(x,x)", comment: "", children: [], allChildren: [] }, null, 2)}\n`,
        "utf8"
      );
      const validation = validateLibrary(dir);
      assert.equal(validation.ok, false);
      assert.ok(validation.issues.some((item) => item.check === "filename"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the real function library", { skip: !existsSync(realLibrary) }, () => {
    const validation = validateLibrary(realLibrary);
    const errorsFor = (file: string) => validation.issues.filter((item) => item.file === file && item.severity === "error");
    assert.deepEqual(errorsFor("Dist.json"), []);
    assert.ok(errorsFor("s2k_ProgramControl.json").some((item) => item.check === "empty"));
    assert.equal(
      errorsFor("CreateHatch.json").some((item) => item.check === "child-missing-from-formula"),
      false
    );
    const listed = listFunctions(realLibrary);
    assert.ok(listed.functions.some((fn) => fn.name === "Dist"));
  });
});
