import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  LfmError,
  deleteFunction,
  getFunction,
  libraryClosure,
  listFunctions,
  upsertFunction,
  validateLibrary,
  type LibraryListFilter,
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

function withLibrary(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "lfm-meta-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeLibraryFile(dir: string, body: Record<string, unknown>): void {
  const name = body.name;
  if (typeof name !== "string" || name === "") throw new Error("test file needs a name");
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function readLibraryFile(dir: string, name: string): { text: string; body: Record<string, unknown> } {
  const text = readFileSync(path.join(dir, `${name}.json`), "utf8");
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

function coreFile(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    formula: "=LAMBDA(x,x)",
    comment: "",
    children: [],
    allChildren: [],
    ...extra,
  };
}

describe("library role, group, and tags", () => {
  it("lists a dotted name as its prefix when no group is stored", () => {
    withLibrary((dir) => {
      upsertFunction({ name: "Strip.Forces", formula: "=LAMBDA(x,x)", comment: "strip" }, dir);
      upsertFunction({ name: "A.B.C", formula: "=LAMBDA(x,x)", comment: "" }, dir);
      const listed = new Map(listFunctions(dir).functions.map((fn) => [fn.name, fn]));
      assert.equal(listed.get("Strip.Forces")?.group, "Strip");
      assert.equal(listed.get("Strip.Forces")?.groupAssigned, false);
      assert.equal(listed.get("A.B.C")?.group, "A");
      assert.equal(listed.get("A.B.C")?.groupAssigned, false);
      const strip = readLibraryFile(dir, "Strip.Forces").body;
      assert.equal("group" in strip, false);
      assert.equal("role" in strip, false);
      assert.equal("tags" in strip, false);
      const loaded = getFunction("Strip.Forces", dir);
      assert.equal(loaded.group, "Strip");
      assert.equal(loaded.groupAssigned, false);
      assert.equal(loaded.role, "public");
      assert.deepEqual(loaded.tags, []);
    });
  });

  it("lists a name with no dot as Ungrouped", () => {
    withLibrary((dir) => {
      upsertFunction({ name: "Dist", formula: "=LAMBDA(x,x)", comment: "" }, dir);
      upsertFunction({ name: "SHELL_QUAD", formula: "=LAMBDA(x,x)", comment: "" }, dir);
      upsertFunction({ name: ".Hidden", formula: "=LAMBDA(x,x)", comment: "" }, dir);
      const listed = new Map(listFunctions(dir).functions.map((fn) => [fn.name, fn]));
      assert.equal(listed.get("Dist")?.group, "Ungrouped");
      assert.equal(listed.get("Dist")?.groupAssigned, false);
      assert.equal(listed.get("SHELL_QUAD")?.group, "Ungrouped");
      assert.equal(listed.get("SHELL_QUAD")?.groupAssigned, false);
      assert.equal(listed.get(".Hidden")?.group, "Ungrouped");
      assert.equal("group" in readLibraryFile(dir, "Dist").body, false);
      assert.equal("group" in readLibraryFile(dir, "SHELL_QUAD").body, false);
      assert.equal("group" in readLibraryFile(dir, ".Hidden").body, false);
    });
  });

  it("lists a stored group override and groupAssigned", () => {
    withLibrary((dir) => {
      writeLibraryFile(dir, coreFile("SHELL_QUAD", { group: "Shell", comment: "quad" }));
      writeLibraryFile(dir, coreFile("Pad", { group: "  Shell  " }));
      writeLibraryFile(dir, coreFile("Blank", { group: "   " }));
      const listed = new Map(listFunctions(dir).functions.map((fn) => [fn.name, fn]));
      assert.equal(listed.get("SHELL_QUAD")?.group, "Shell");
      assert.equal(listed.get("SHELL_QUAD")?.groupAssigned, true);
      assert.equal(listed.get("Pad")?.group, "Shell");
      assert.equal(listed.get("Pad")?.groupAssigned, true);
      assert.equal(listed.get("Blank")?.group, "Ungrouped");
      assert.equal(listed.get("Blank")?.groupAssigned, false);
      assert.ok(
        validateLibrary(dir).issues.some((item) => item.file === "Blank.json" && item.check === "group")
      );
      const loaded = getFunction("SHELL_QUAD", dir);
      assert.equal(loaded.group, "Shell");
      assert.equal(loaded.groupAssigned, true);
      assert.equal(readLibraryFile(dir, "SHELL_QUAD").body.group, "Shell");
      assert.equal(readLibraryFile(dir, "Pad").body.group, "  Shell  ");
    });
  });

  it("keeps stored metadata and unknown keys on a formula-only upsert", () => {
    withLibrary((dir) => {
      writeLibraryFile(
        dir,
        coreFile("Keeper", {
          formula: "=LAMBDA(x,{ref}Old(x))",
          comment: "stored comment",
          children: ["Old"],
          allChildren: ["Old"],
          role: "helper",
          group: "Shell",
          tags: ["vector"],
          note: "keep-me",
        })
      );
      upsertFunction({ name: "Keeper", formula: "=LAMBDA(x,{ref}New(x))" }, dir);
      const loaded = getFunction("Keeper", dir);
      assert.equal(loaded.formula, "=LAMBDA(x,{ref}New(x))");
      assert.deepEqual(loaded.children, ["New"]);
      assert.deepEqual(loaded.allChildren, ["New"]);
      assert.equal(loaded.comment, "stored comment");
      assert.equal(loaded.role, "helper");
      assert.equal(loaded.group, "Shell");
      assert.equal(loaded.groupAssigned, true);
      assert.deepEqual(loaded.tags, ["vector"]);
      const { body } = readLibraryFile(dir, "Keeper");
      assert.equal(body.comment, "stored comment");
      assert.equal(body.role, "helper");
      assert.equal(body.group, "Shell");
      assert.deepEqual(body.tags, ["vector"]);
      assert.equal(body.note, "keep-me");
      assert.deepEqual(body.children, ["New"]);
    });
  });

  it("keeps a stored comment when comment is omitted and writes an empty comment when passed", () => {
    withLibrary((dir) => {
      writeLibraryFile(dir, coreFile("Noted", { comment: "stored comment" }));
      upsertFunction({ name: "Noted", formula: "=LAMBDA(x,x+1)" }, dir);
      let body = readLibraryFile(dir, "Noted").body;
      assert.equal(body.comment, "stored comment");
      assert.equal(body.formula, "=LAMBDA(x,x+1)");
      assert.equal("role" in body, false);
      assert.equal("group" in body, false);
      assert.equal("tags" in body, false);
      assert.equal(getFunction("Noted", dir).comment, "stored comment");

      upsertFunction({ name: "Noted", formula: "=LAMBDA(x,x+1)", comment: "" }, dir);
      body = readLibraryFile(dir, "Noted").body;
      assert.equal(body.comment, "");
      assert.equal("group" in body, false);
    });
  });

  it("clears tags with an empty array and removes a stored group with an empty string", () => {
    withLibrary((dir) => {
      upsertFunction(
        {
          name: "Strip.Forces",
          formula: "=LAMBDA(x,x)",
          comment: "beam",
          role: "helper",
          group: "Custom",
          tags: ["vector"],
        },
        dir
      );
      upsertFunction(
        {
          name: "Strip.Forces",
          formula: "=LAMBDA(x,x)",
          group: "",
          tags: [],
        },
        dir
      );
      const loaded = getFunction("Strip.Forces", dir);
      assert.equal(loaded.group, "Strip");
      assert.equal(loaded.groupAssigned, false);
      assert.deepEqual(loaded.tags, []);
      assert.equal(loaded.role, "helper");
      assert.equal(loaded.comment, "beam");
      const { body } = readLibraryFile(dir, "Strip.Forces");
      assert.equal("group" in body, false);
      assert.deepEqual(body.tags, []);
      assert.equal(body.role, "helper");
      assert.equal(body.comment, "beam");
    });
  });

  it("writes role on a new helper and does not guess a group", () => {
    withLibrary((dir) => {
      upsertFunction({ name: "Strip.Forces", formula: "=LAMBDA(x,x)", role: "helper" }, dir);
      const { body } = readLibraryFile(dir, "Strip.Forces");
      assert.equal(body.role, "helper");
      assert.equal(body.comment, "");
      assert.equal("group" in body, false);
      assert.equal("tags" in body, false);
      const loaded = getFunction("Strip.Forces", dir);
      assert.equal(loaded.role, "helper");
      assert.equal(loaded.group, "Strip");
      assert.equal(loaded.groupAssigned, false);
      assert.deepEqual(loaded.tags, []);
    });
  });

  it("filters by effective role, group, and tag, and includes helpers by default", () => {
    withLibrary((dir) => {
      upsertFunction({ name: "Alpha.One", formula: "=LAMBDA(x,x)", comment: "", tags: ["keep"] }, dir);
      upsertFunction(
        {
          name: "Beta",
          formula: "=LAMBDA(x,x)",
          comment: "",
          role: "helper",
          group: "Tools",
          tags: ["keep", "other"],
        },
        dir
      );
      upsertFunction({ name: "Gamma", formula: "=LAMBDA(x,x)", comment: "", tags: ["other"] }, dir);

      const names = (filter?: LibraryListFilter) => listFunctions(dir, filter).functions.map((fn) => fn.name);
      assert.deepEqual(names(), ["Alpha.One", "Beta", "Gamma"]);
      assert.deepEqual(names({ role: "public" }), ["Alpha.One", "Gamma"]);
      assert.deepEqual(names({ role: "helper" }), ["Beta"]);
      assert.deepEqual(names({ group: "Alpha" }), ["Alpha.One"]);
      assert.deepEqual(names({ group: "Tools" }), ["Beta"]);
      assert.deepEqual(names({ group: "Ungrouped" }), ["Gamma"]);
      assert.deepEqual(names({ tag: "keep" }), ["Alpha.One", "Beta"]);
      assert.deepEqual(names({ tag: "other" }), ["Beta", "Gamma"]);
      assert.deepEqual(names({ role: "public", tag: "keep" }), ["Alpha.One"]);
      assert.throws(
        () => listFunctions(dir, { role: "internal" }),
        (error: unknown) => {
          assert.ok(error instanceof LfmError);
          assert.match((error as LfmError).message, /"public" or "helper"/);
          return true;
        }
      );

      const beta = listFunctions(dir).functions.find((fn) => fn.name === "Beta");
      assert.ok(beta);
      assert.equal(beta.role, "helper");
      assert.equal(beta.group, "Tools");
      assert.equal(beta.groupAssigned, true);
      assert.deepEqual(beta.tags, ["keep", "other"]);
      const got = getFunction("Beta", dir);
      assert.equal(got.role, "helper");
      assert.equal(got.group, "Tools");
      assert.equal(got.groupAssigned, true);
      assert.deepEqual(got.tags, ["keep", "other"]);
    });
  });

  it("reports invalid role, group, and tags without failing files that omit them", () => {
    withLibrary((dir) => {
      writeLibraryFile(dir, coreFile("Plain"));
      writeLibraryFile(dir, coreFile("Good", { role: "public", group: "Shell", tags: ["vector"] }));
      writeLibraryFile(dir, coreFile("Bad", { role: "internal", group: ["Shell"], tags: "vector" }));

      const validation = validateLibrary(dir);
      const errorsFor = (file: string) =>
        validation.issues.filter((item) => item.file === file && item.severity === "error");
      assert.deepEqual(errorsFor("Plain.json"), []);
      assert.deepEqual(errorsFor("Good.json"), []);
      assert.deepEqual(
        errorsFor("Bad.json")
          .map((item) => item.check)
          .sort(),
        ["group", "role", "tags"]
      );
      assert.equal(validation.ok, false);

      const listed = new Map(listFunctions(dir).functions.map((fn) => [fn.name, fn]));
      assert.deepEqual(Array.from(listed.keys()).sort(), ["Bad", "Good", "Plain"]);
      assert.equal(listed.get("Plain")?.role, "public");
      assert.equal(listed.get("Plain")?.group, "Ungrouped");
      assert.equal(listed.get("Plain")?.groupAssigned, false);
      assert.deepEqual(listed.get("Plain")?.tags, []);
      assert.equal(listed.get("Bad")?.role, "public");
      assert.equal(listed.get("Bad")?.group, "Ungrouped");
      assert.equal(listed.get("Bad")?.groupAssigned, false);
      assert.deepEqual(listed.get("Bad")?.tags, []);
      assert.equal(getFunction("Bad", dir).role, "public");
      assert.deepEqual(getFunction("Bad", dir).tags, []);
    });
  });

  it("does not rewrite an invalid role, group, or tags value on a formula-only upsert", () => {
    withLibrary((dir) => {
      writeLibraryFile(
        dir,
        coreFile("BadMeta", {
          comment: "keep",
          role: "internal",
          group: ["Shell"],
          tags: "vector",
          note: "keep-me",
        })
      );
      upsertFunction({ name: "BadMeta", formula: "=LAMBDA(x,x+1)" }, dir);
      const { text, body } = readLibraryFile(dir, "BadMeta");
      assert.match(text, /"role": "internal"/);
      assert.equal(body.role, "internal");
      assert.deepEqual(body.group, ["Shell"]);
      assert.equal(body.tags, "vector");
      assert.equal(body.comment, "keep");
      assert.equal(body.note, "keep-me");
      assert.equal(body.formula, "=LAMBDA(x,x+1)");
      assert.equal(getFunction("BadMeta", dir).role, "public");
      assert.deepEqual(getFunction("BadMeta", dir).tags, []);
    });
  });
});
