import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const helpText = `lfm-mcp

Starts the Lambda library MCP server on stdio.

Options:
  --library <folder>   Folder of function JSON files. Saved for the next run.
  --help               Show this help.

The saved folder is %LOCALAPPDATA%\\lfm-mcp\\config.json.
`;

interface LfmConfig {
  libraryDir?: string;
}

export function configDirectory(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "lfm-mcp");
}

export function configFile(): string {
  return path.join(configDirectory(), "config.json");
}

export function readConfig(): LfmConfig {
  const file = configFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LfmConfig;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function writeConfig(config: LfmConfig): void {
  mkdirSync(configDirectory(), { recursive: true });
  writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Saved folder, when it still exists. */
export function savedLibraryDir(): string | undefined {
  const saved = readConfig().libraryDir;
  if (!saved) return undefined;
  try {
    if (existsSync(saved) && statSync(saved).isDirectory()) return saved;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Remember a folder and use it for this process. */
export function rememberLibrary(folder: string): string {
  const resolved = path.resolve(folder);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Library folder not found: ${resolved}`);
  }
  const config = readConfig();
  config.libraryDir = resolved;
  writeConfig(config);
  process.env.LFM_LIBRARY_DIR = resolved;
  return resolved;
}

export function readCli(argv: readonly string[]): { help: boolean; library?: string } {
  let help = false;
  let library: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--library" || arg.startsWith("--library=")) {
      const value = arg === "--library" ? argv[++i] : arg.slice("--library=".length);
      if (!value) throw new Error("--library requires a folder path.");
      library = value;
    }
  }
  return { help, library };
}
