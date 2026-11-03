import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const bundle = path.join(dist, "lfm-mcp.cjs");
const blob = path.join(dist, "sea-prep.blob");
const exe = path.join(dist, "lfm-mcp.exe");
const seaConfig = path.join(dist, "sea-config.json");
const script = readFileSync(path.join(root, "src", "excel-names.ps1"), "utf8");

mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, "src", "mcp.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile: bundle,
  logOverride: { "empty-import-meta": "silent" },
  plugins: [
    {
      name: "embed-excel-script",
      setup(build) {
        build.onResolve({ filter: /^excel-names-script$/ }, (args) => ({
          path: args.path,
          namespace: "excel-script",
        }));
        build.onLoad({ filter: /.*/, namespace: "excel-script" }, () => ({
          contents: `exports.embeddedExcelNamesScript = ${JSON.stringify(script)};`,
          loader: "js",
        }));
      },
    },
  ],
});

writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
    },
    null,
    2
  )
);

const node = spawn(process.execPath, ["--experimental-sea-config", seaConfig], {
  cwd: root,
  stdio: "inherit",
});
const seaCode = await new Promise((resolve) => node.on("exit", resolve));
if (seaCode !== 0) process.exit(seaCode ?? 1);

copyFileSync(process.execPath, exe);
const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
const inject = spawn(
  process.execPath,
  [
    postject,
    exe,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { cwd: root, stdio: "inherit" }
);
const injectCode = await new Promise((resolve) => inject.on("exit", resolve));
if (injectCode !== 0) process.exit(injectCode ?? 1);

const home = await mkdtemp(path.join(tmpdir(), "lfm-exe-"));
const library = path.join(home, "Functions");
mkdirSync(library);
writeFileSync(
  path.join(library, "Echo.json"),
  JSON.stringify({ name: "Echo", formula: "=LAMBDA(x,x)", comment: "", children: [], allChildren: [] })
);

const child = spawn(exe, ["--library", library], {
  cwd: home,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, LOCALAPPDATA: home },
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "build", version: "1.0.0" } },
  })}\n`
);

const deadline = Date.now() + 20_000;
let asked = false;
let listed = false;
while (Date.now() < deadline && !listed) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!asked && lines.some((line) => line.includes('"id":1'))) {
    asked = true;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "library_list", arguments: {} },
      })}\n`
    );
  }
  listed = stdout.includes('"id":2') && stdout.includes("Echo");
}
const exited = new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
  else child.once("exit", () => resolve(undefined));
});
child.kill();
const stopped = await Promise.race([
  exited.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
]);
if (!stopped && child.pid) {
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  await exited;
}
try {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch {
  // The executable can keep the temp folder open for a moment after exit.
}
rmSync(bundle, { force: true });
rmSync(blob, { force: true });
rmSync(seaConfig, { force: true });

if (!listed) {
  console.error(stderr || stdout || "lfm-mcp.exe did not list the sample library.");
  process.exit(1);
}

console.log(exe);
