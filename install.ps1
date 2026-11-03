param(
  [string]$Source
)

$ErrorActionPreference = "Stop"
$release = "https://github.com/lucas0623/lfm-mcp/releases/latest/download/lfm-mcp.exe"

if (-not $Source -and $PSScriptRoot) {
  $local = Join-Path $PSScriptRoot "dist\lfm-mcp.exe"
  if (Test-Path -LiteralPath $local) { $Source = $local }
}

if (-not $Source) {
  $Source = Join-Path $env:TEMP "lfm-mcp.exe"
  Invoke-WebRequest -Uri $release -OutFile $Source
}

$destDir = Join-Path $env:LOCALAPPDATA "lfm-mcp"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item -LiteralPath $Source -Destination (Join-Path $destDir "lfm-mcp.exe") -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @()
if ($userPath) { $parts = $userPath -split ";" | Where-Object { $_ -and ($_ -ne $destDir) } }
$parts += $destDir
[Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
$env:Path = "$env:Path;$destDir"

Write-Host "Installed $destDir\lfm-mcp.exe"
Write-Host "Open a new terminal, then point Cursor at:"
Write-Host @'
{
  "mcpServers": {
    "lfm": {
      "command": "lfm-mcp",
      "args": ["--library", "D:\\path\\to\\Functions"]
    }
  }
}
'@
Write-Host "After one successful start, the args line can be removed."
