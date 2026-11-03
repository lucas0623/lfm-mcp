import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..");

function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

describe("MCP server", () => {
  it("lists the library and workbook tools", async () => {
    const child = spawn(process.execPath, [path.join(packageRoot, "bin", "lfm-mcp.js")], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, LFM_LIBRARY_DIR: "lambda-function-library-doc/Functions" },
    });
    let stderr = "";
    let stdout = "";
    let exitCode: number | null = null;
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("exit", (code) => {
      exitCode = code;
    });

    const request = (id: number, method: string, params: unknown) => {
      child.stdin.write(encode({ jsonrpc: "2.0", id, method, params }));
    };

    request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lfm-test", version: "1.0.0" },
    });

    const deadline = Date.now() + 20_000;
    let listedTools = false;
    const messages: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline && !messages.some((message) => message.id === 2) && exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        messages.push(JSON.parse(trimmed) as Record<string, unknown>);
      }
      if (!listedTools && messages.some((message) => message.id === 1)) {
        listedTools = true;
        child.stdin.write(encode({ jsonrpc: "2.0", method: "notifications/initialized" }));
        request(2, "tools/list", {});
      }
    }

    child.kill();
    const listed = messages.find((message) => message.id === 2);
    assert.ok(listed, stderr || stdout || `MCP server did not list tools (exit ${exitCode}).`);
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.deepEqual(tools.sort(), [
      "library_closure",
      "library_delete",
      "library_get",
      "library_list",
      "library_upsert",
      "library_validate",
      "workbook_export",
      "workbook_import",
      "workbook_list",
    ]);
  });
});
