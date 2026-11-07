import { isSea } from "node:sea";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { helpText, readCli, useLibrary } from "./config.ts";
import * as z from "zod/v4";
import {
  deleteFunction,
  exportFromWorkbook,
  getFunction,
  importToWorkbook,
  libraryClosure,
  listFunctions,
  listWorkbookLambdas,
  upsertFunction,
  validateLibrary,
} from "./index.ts";

const libraryDir = z
  .string()
  .optional()
  .describe(
    "Folder of Functions/*.json. Defaults to the MCP server --library argument, then LFM_LIBRARY_DIR, then this repo's lambda-function-library-doc/Functions."
  );

const workbookPath = z
  .string()
  .optional()
  .describe(
    'Absolute path to an .xlsx or .xlsm file. Omit, or pass "active", to use the workbook active in desktop Excel. A path that is already open is updated in place and left open.'
  );

const scope = z.enum(["Workbook", "Worksheet"]).describe("Workbook removes {ref}. Worksheet replaces {ref} with the sheet prefix.");

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(action: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    return fail(error);
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "lfm",
    version: "1.0.0",
  });

  server.registerTool(
    "library_list",
    {
      title: "List Lambda library",
      description:
        "List Lambda functions in the library folder. Results include name, comment, children, allChildren, role, the effective group, groupAssigned, and tags. The default list returns every function, including helpers. Use library_get for the formula.",
      inputSchema: z.object({
        libraryDir,
        role: z
          .enum(["public", "helper"])
          .optional()
          .describe("Return only functions with this effective role. Omit to include every function."),
        group: z.string().optional().describe("Return only functions whose effective group equals this value."),
        tag: z.string().optional().describe("Return only functions that include this effective tag."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      run(() =>
        listFunctions(args.libraryDir, {
          role: args.role,
          group: args.group,
          tag: args.tag,
        })
      )
  );

  server.registerTool(
    "library_get",
    {
      title: "Get Lambda function",
      description:
        "Read one library function, including its formula, role, effective group, groupAssigned, and tags. Child calls in the formula use {ref}Name(.",
      inputSchema: z.object({
        name: z.string().describe("Function name, matching the JSON file name."),
        libraryDir,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => run(() => getFunction(args.name, args.libraryDir))
  );

  server.registerTool(
    "library_validate",
    {
      title: "Validate Lambda library",
      description:
        "Check library JSON: file name matches name, formula starts with =LAMBDA, and children match {ref}Name( calls. Warnings name children that have no file yet.",
      inputSchema: z.object({
        libraryDir,
        names: z.array(z.string()).optional().describe("Validate only these functions. Omit to validate the whole library."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => run(() => validateLibrary(args.libraryDir, args.names))
  );

  server.registerTool(
    "library_upsert",
    {
      title: "Write Lambda function",
      description:
        "Create or update one library JSON file. The formula must start with =LAMBDA and call each child as {ref}Name(. children and allChildren are computed. A call written as Sheet!Name( or Name( is rejected. On an existing file, omitted role, group, tags, comment, and any other keys are kept.",
      inputSchema: z.object({
        name: z.string().describe("Function name. Written to <name>.json."),
        formula: z.string().describe("Library formula starting with =LAMBDA. Child calls are {ref}Name(."),
        comment: z
          .string()
          .optional()
          .describe("Description stored in the JSON file. On update, omit this to keep the stored comment."),
        role: z.enum(["public", "helper"]).optional().describe("Stored role. Omit to keep the stored role."),
        group: z
          .string()
          .optional()
          .describe("Stored group override. A blank string removes the stored group. Omit to keep the stored group."),
        tags: z
          .array(z.string())
          .optional()
          .describe("An empty array clears tags. Omit to keep stored tags."),
        libraryDir,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(() =>
        upsertFunction(
          {
            name: args.name,
            formula: args.formula,
            comment: args.comment,
            role: args.role,
            group: args.group,
            tags: args.tags,
          },
          args.libraryDir
        )
      )
  );

  server.registerTool(
    "library_delete",
    {
      title: "Delete Lambda function",
      description: "Delete one function's JSON file from the library folder.",
      inputSchema: z.object({
        name: z.string().describe("Function name to delete."),
        libraryDir,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => run(() => deleteFunction(args.name, args.libraryDir))
  );

  server.registerTool(
    "library_closure",
    {
      title: "Lambda function closure",
      description: "Return a function plus every library function it calls, with formulas. This is the set workbook_import writes.",
      inputSchema: z.object({
        names: z.array(z.string()).min(1).describe("Function names to expand."),
        libraryDir,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => run(() => libraryClosure(args.names, args.libraryDir))
  );

  server.registerTool(
    "workbook_list",
    {
      title: "List workbook LAMBDAs",
      description:
        "Read LAMBDA defined names from an .xlsx or .xlsm file through desktop Excel. Does not calculate the formulas and does not use the task pane. Omit workbookPath, or pass active, to read the workbook that is active in Excel. An open file is left open.",
      inputSchema: z.object({ workbookPath }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => run(() => listWorkbookLambdas(args.workbookPath))
  );

  server.registerTool(
    "workbook_import",
    {
      title: "Import library into workbook",
      description:
        "Write library functions into a workbook as defined names. {ref} becomes the sheet prefix at Worksheet scope, and is removed at Workbook scope. Dependencies are included. Requires desktop Excel. The file must already exist, unless workbookPath is omitted or active, which uses the workbook open in Excel. An already-open file is saved and left open.",
      inputSchema: z.object({
        workbookPath,
        names: z.array(z.string()).min(1).describe("Library function names to import."),
        scope,
        sheet: z.string().optional().describe("Required when scope is Worksheet. Ignored for Workbook."),
        libraryDir,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(() =>
        importToWorkbook({
          workbookPath: args.workbookPath,
          names: args.names,
          scope: args.scope,
          sheet: args.sheet,
          libraryDir: args.libraryDir,
        })
      )
  );

  server.registerTool(
    "workbook_export",
    {
      title: "Export workbook LAMBDAs",
      description:
        "Read LAMBDA defined names from a workbook and write them into the library as JSON. Sheet!Name( on the given sheet becomes {ref}Name(. Pass sheet for workbook-scoped names that still use a sheet prefix. Requires desktop Excel. Omit workbookPath, or pass active, to read the workbook that is active in Excel. An open file is left open. An existing file keeps stored role, group, tags, and any other keys. formula, children, and allChildren are updated. comment is updated because export always sends the Excel comment.",
      inputSchema: z.object({
        workbookPath,
        names: z
          .array(z.string())
          .optional()
          .describe("Names to export. Omit to export every LAMBDA defined name. Dependencies in the workbook are included."),
        sheet: z
          .string()
          .optional()
          .describe("Sheet prefix to collapse into {ref} for workbook-scoped names. Worksheet-scoped names use their own sheet."),
        libraryDir,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(() =>
        exportFromWorkbook({
          workbookPath: args.workbookPath,
          names: args.names,
          sheet: args.sheet,
          libraryDir: args.libraryDir,
        })
      )
  );

  return server;
}

function isDirectRun(): boolean {
  if (isSea()) return true;
  const entry = process.argv[1];
  if (entry && import.meta.url) return path.resolve(entry) === fileURLToPath(import.meta.url);
  // The single-file executable has no import.meta.url, and this module is its entry point.
  return !import.meta.url;
}

if (isDirectRun()) {
  try {
    const cli = readCli(process.argv.slice(2));
    if (cli.help) {
      console.error(helpText);
      process.exit(0);
    }
    if (cli.library) useLibrary(cli.library);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
