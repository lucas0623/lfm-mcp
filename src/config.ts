import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const helpText = `lfm-mcp

Starts the Lambda library MCP server on stdio.

Options:
  --library <folder>   Folder of function JSON files. Read on every start.
  --help               Show this help.

Pass --library from the MCP server args. The folder is not saved to a config file.
When --library is omitted, LFM_LIBRARY_DIR is used.
`;

/** Check the folder and use it for this process. Does not write a config file. */
export function useLibrary(folder: string): string {
  const resolved = path.resolve(folder);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Library folder not found: ${resolved}`);
  }
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
