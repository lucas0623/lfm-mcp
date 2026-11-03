# lfm-mcp

MCP server for the [Excel Lambda function library](https://github.com/lucas0623/excel-lambda-function-library). A Cursor agent can list and edit the function JSON, and, on desktop Excel for Windows, import those functions into a workbook or export LAMBDA names back to the library.

The executable does not include the functions. Clone the library repository and point `--library` at its `Functions` folder.

## Install with Cursor

Windows only. Workbook import and export also need desktop Excel.

1. Install the program:

```powershell
irm https://raw.githubusercontent.com/lucas0623/lfm-mcp/main/install.ps1 | iex
```

This downloads `lfm-mcp.exe` into `%LOCALAPPDATA%\lfm-mcp` and adds that folder to your user PATH. Open a new terminal, or restart Cursor, so `lfm-mcp` is found.

2. Clone the function library and remember the `Functions` folder:

```powershell
git clone https://github.com/lucas0623/excel-lambda-function-library.git
```

3. In Cursor, open **Settings → MCP** and add a server, or create `.cursor/mcp.json` in a project (or `%USERPROFILE%\.cursor\mcp.json` for every project):

```json
{
  "mcpServers": {
    "lfm": {
      "command": "lfm-mcp",
      "args": ["--library", "C:\\path\\to\\excel-lambda-function-library\\Functions"]
    }
  }
}
```

Replace the path with your clone and keep the `args` line. The server reads that path on every start and does not store a second copy. In JSON, write each backslash twice: `C:\\path\\to\\Functions`.

4. Enable the `lfm` server in Cursor settings. A new chat can then call `library_list`, `library_get`, `library_validate`, `library_upsert`, `library_delete`, `library_closure`, `workbook_list`, `workbook_import`, and `workbook_export`.

`workbook_list`, `workbook_import`, and `workbook_export` can use a workbook that is already open in desktop Excel. Leave out `workbookPath`, or pass `active`, to use the active workbook. A path that is already open is saved and left open. A closed file is opened in a separate Excel, saved, and closed.
