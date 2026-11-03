param(
  [Parameter(Mandatory = $true)][string]$CommandPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$excel = $null
$wb = $null
$save = $false
$ok = $false
$message = $null
$names = New-Object System.Collections.ArrayList
$imported = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList

function ConvertTo-JsonValue($value) {
  if ($null -eq $value) { return "null" }
  if ($value -is [bool]) {
    if ($value) { return "true" }
    return "false"
  }
  if ($value -is [System.Collections.IList] -and -not ($value -is [string])) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $value) { [void]$parts.Add((ConvertTo-JsonValue $item)) }
    return "[" + ($parts -join ",") + "]"
  }
  if ($value -is [System.Collections.IDictionary]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($key in @($value.Keys)) {
      [void]$parts.Add(((ConvertTo-JsonValue ([string]$key))) + ":" + (ConvertTo-JsonValue $value[$key]))
    }
    return "{" + ($parts -join ",") + "}"
  }
  return (ConvertTo-Json -InputObject ([string]$value) -Compress)
}

function Write-Result {
  $result = New-Object System.Collections.Hashtable
  $result["ok"] = [bool]$ok
  if ($message) { $result["message"] = [string]$message }
  $result["names"] = $names
  $result["imported"] = $imported
  $result["failed"] = $failed
  $json = ConvertTo-JsonValue $result
  [System.IO.File]::WriteAllText($ResultPath, $json, [System.Text.UTF8Encoding]::new($false))
}

function As-Array($value) {
  if ($null -eq $value) { return @() }
  if ($value -is [System.Array]) { return $value }
  return @($value)
}

function Get-NameParts($namedItem) {
  $full = [string]$namedItem.Name
  $bang = $full.LastIndexOf("!")
  if ($bang -ge 0) {
    $sheet = $full.Substring(0, $bang).Trim("'").Replace("''", "'")
    return @{ scope = "Worksheet"; sheet = $sheet; name = $full.Substring($bang + 1) }
  }
  return @{ scope = "Workbook"; sheet = $null; name = $full }
}

function Set-LambdaName($collection, $name, $formula, $comment) {
  $existing = $null
  $count = $collection.Count
  for ($i = 1; $i -le $count; $i++) {
    $item = $collection.Item($i)
    $parts = Get-NameParts $item
    if ([string]::Equals([string]$parts.name, $name, [System.StringComparison]::OrdinalIgnoreCase)) {
      $existing = $item
      break
    }
  }

  if ($null -ne $existing) {
    $existing.RefersTo = $formula
    try { $existing.Comment = $comment } catch {}
  } else {
    $created = $collection.Add($name, $formula)
    try { $created.Comment = $comment } catch {}
  }
}

try {
  $commandText = [System.IO.File]::ReadAllText($CommandPath, [System.Text.UTF8Encoding]::new($false))
  $command = $commandText | ConvertFrom-Json
  $workbookPath = [string]$command.workbookPath
  if (-not (Test-Path -LiteralPath $workbookPath)) {
    throw "Workbook not found: $workbookPath"
  }

  # New Excel.Application, not Get-Object, so an Excel the user already has open stays open.
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AskToUpdateLinks = $false
  $excel.ReferenceStyle = 1
  $wb = $excel.Workbooks.Open($workbookPath, 0, $false)

  if ($command.action -eq "list") {
    $count = $wb.Names.Count
    for ($i = 1; $i -le $count; $i++) {
      $namedItem = $wb.Names.Item($i)
      $parts = Get-NameParts $namedItem
      $short = [string]$parts.name
      if ($short.StartsWith("_xl") -or $short -eq "_FilterDatabase") { continue }
      $formula = ""
      try { $formula = [string]$namedItem.RefersTo } catch { continue }
      if ($formula -notmatch '^\s*=\s*(_xlfn\.)?LAMBDA') { continue }
      $comment = ""
      try { $comment = [string]$namedItem.Comment } catch { $comment = "" }
      $row = New-Object System.Collections.Hashtable
      $row["name"] = $short
      $row["formula"] = $formula
      $row["comment"] = $comment
      $row["scope"] = [string]$parts.scope
      $row["sheet"] = $parts.sheet
      [void]$names.Add($row)
    }
    $ok = $true
  } elseif ($command.action -eq "write") {
    foreach ($item in (As-Array $command.items)) {
      $itemName = [string]$item.name
      try {
        if ($item.scope -eq "Worksheet") {
          $sheetName = [string]$item.sheet
          $worksheet = $null
          try { $worksheet = $wb.Worksheets.Item($sheetName) } catch { throw "Worksheet '$sheetName' was not found." }
          Set-LambdaName $worksheet.Names $itemName ([string]$item.formula) ([string]$item.comment)
        } else {
          Set-LambdaName $wb.Names $itemName ([string]$item.formula) ([string]$item.comment)
        }
        [void]$imported.Add($itemName)
      } catch {
        $failure = New-Object System.Collections.Hashtable
        $failure["name"] = $itemName
        $failure["message"] = $_.Exception.Message
        [void]$failed.Add($failure)
      }
    }
    if ($imported.Count -gt 0) { $save = $true }
    $ok = $true
  } else {
    throw "Unknown Excel action: $($command.action)"
  }
} catch {
  $ok = $false
  $message = $_.Exception.Message
} finally {
  if ($null -ne $wb) {
    try {
      if ($save) { $wb.Save() }
    } catch {
      $ok = $false
      $message = "Workbook save failed: $($_.Exception.Message)"
    }
    try { $wb.Close($false) } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) } catch {}
  }
  if ($null -ne $excel) {
    try { $excel.Quit() } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

Write-Result
if (-not $ok) { exit 1 }
