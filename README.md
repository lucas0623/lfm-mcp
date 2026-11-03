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

2. Clone the function library. The next step passes its `Functions` folder to the server:

```powershell
git clone https://github.com/lucas0623/excel-lambda-function-library.git
```

3. In Cursor, open **Settings → MCP** and add a server, or create `%USERPROFILE%\.cursor\mcp.json` (every project) or `.cursor/mcp.json` (one project):

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

Keep the `args` line. `lfm-mcp` reads `--library` on every start and does not save the folder. To point at a different clone, edit this path and restart the `lfm` server. In JSON, write each backslash twice: `C:\\path\\to\\Functions`.

4. Enable the `lfm` server in Cursor settings. A new chat can then call `library_list`, `library_get`, `library_validate`, `library_upsert`, `library_delete`, `library_closure`, `workbook_list`, `workbook_import`, and `workbook_export`.

## Workbooks

`workbook_list`, `workbook_import`, and `workbook_export` use desktop Excel.

- Omit `workbookPath`, or pass `active`, to use the workbook that is active in Excel.
- A path that is already open is saved and left open. Saving writes the whole file, including other unsaved edits. A workbook that has never been saved, such as `Book1`, receives the names in memory and is not written to disk.
- A closed file is opened in a separate Excel, saved, and closed.
