import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addinPath = path.join(packageRoot, "..", "lambda-function-manager", "src", "shared", "lambdaFormula.ts");

describe("formula helper", () => {
  it("matches the add-in copy", { skip: !existsSync(addinPath) }, () => {
    const local = readFileSync(path.join(packageRoot, "src", "lambdaFormula.ts"));
    const addin = readFileSync(addinPath);
    assert.deepEqual(local, addin);
  });
});
