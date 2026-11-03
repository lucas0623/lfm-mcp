param(
  [Parameter(Mandatory = $true)][string]$CommandPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$excel = $null
$wb = $null
$save = $false
$saved = $false
$ok = $false
$attached = $false
$owned = $false
$message = $null
$resolvedPath = $null
$requestedPath = $null
$previousReferenceStyle = $null
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
  $result["attached"] = [bool]$attached
  $result["saved"] = [bool]$saved
  if ($resolvedPath) { $result["workbookPath"] = [string]$resolvedPath }
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

function Test-SameWorkbookPath([string]$left, [string]$right) {
  if (-not $left -or -not $right) { return $false }
  try {
    $a = [System.IO.Path]::GetFullPath($left)
    $b = [System.IO.Path]::GetFullPath($right)
    return [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return [string]::Equals($left.Trim(), $right.Trim(), [System.StringComparison]::OrdinalIgnoreCase)
  }
}

function Get-ExcelApplications {
  $apps = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  $objects = @()
  try {
    if (-not ("LfmRot" -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class LfmRot {
    [DllImport("ole32.dll")]
    private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable prot);

    [DllImport("ole32.dll")]
    private static extern int CreateBindCtx(int reserved, out IBindCtx ppbc);

    public static object[] GetObjects() {
        var found = new List<object>();
        IRunningObjectTable rot;
        if (GetRunningObjectTable(0, out rot) != 0 || rot == null) return found.ToArray();
        IEnumMoniker enumerator;
        rot.EnumRunning(out enumerator);
        if (enumerator == null) return found.ToArray();
        var monikers = new IMoniker[1];
        while (enumerator.Next(1, monikers, IntPtr.Zero) == 0) {
            IBindCtx ctx;
            if (CreateBindCtx(0, out ctx) != 0 || ctx == null) continue;
            string displayName;
            try { monikers[0].GetDisplayName(ctx, null, out displayName); }
            catch { continue; }
            if (string.IsNullOrEmpty(displayName)) continue;
            bool interesting = displayName.IndexOf("Excel", StringComparison.OrdinalIgnoreCase) >= 0
                || displayName.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase)
                || displayName.EndsWith(".xlsm", StringComparison.OrdinalIgnoreCase)
                || displayName.EndsWith(".xls", StringComparison.OrdinalIgnoreCase)
                || displayName.EndsWith(".xlsb", StringComparison.OrdinalIgnoreCase);
            if (!interesting) continue;
            object com;
            try { rot.GetObject(monikers[0], out com); }
            catch { continue; }
            if (com != null) found.Add(com);
        }
        return found.ToArray();
    }
}
'@
    }
    $objects = @([LfmRot]::GetObjects())
  } catch {
    $objects = @()
  }
  try {
    $objects += [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
  } catch {}

  foreach ($obj in $objects) {
    if ($null -eq $obj) { continue }
    $app = $null
    $isApp = $false
    try {
      $workbooks = $obj.Workbooks
      $appName = [string]$obj.Name
      if ($null -ne $workbooks -and $appName -like "*Excel*") { $isApp = $true }
    } catch {}
    if ($isApp) { $app = $obj }
    if ($null -eq $app) {
      try { $app = $obj.Application } catch { continue }
    }
    if ($null -eq $app) { continue }
    $hwnd = 0
    try { $hwnd = [int]$app.Hwnd } catch { continue }
    if ($hwnd -eq 0 -or $seen.ContainsKey("$hwnd")) { continue }
    $seen["$hwnd"] = $true
    [void]$apps.Add($app)
  }
  return $apps
}

function Release-OtherExcel($apps, $keep) {
  $keepHwnd = 0
  if ($null -ne $keep) {
    try { $keepHwnd = [int]$keep.Hwnd } catch {}
  }
  foreach ($app in $apps) {
    if ($null -eq $app) { continue }
    $hwnd = 0
    try { $hwnd = [int]$app.Hwnd } catch {}
    if ($null -ne $keep -and (($keepHwnd -ne 0 -and $hwnd -eq $keepHwnd) -or [object]::ReferenceEquals($app, $keep))) {
      continue
    }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
  }
}

function Find-OpenWorkbook($apps, [string]$workbookPath) {
  $targetName = [System.IO.Path]::GetFileName($workbookPath)
  $nameHits = New-Object System.Collections.Generic.List[object]
  foreach ($app in $apps) {
    $count = 0
    try { $count = [int]$app.Workbooks.Count } catch { continue }
    for ($i = 1; $i -le $count; $i++) {
      $candidate = $null
      try { $candidate = $app.Workbooks.Item($i) } catch { continue }
      $full = ""
      try { $full = [string]$candidate.FullName } catch {}
      if (Test-SameWorkbookPath $full $workbookPath) {
        return @{ excel = $app; workbook = $candidate }
      }
      $openName = ""
      try { $openName = [string]$candidate.Name } catch {}
      if ($targetName -and [string]::Equals($openName, $targetName, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void]$nameHits.Add(@{ excel = $app; workbook = $candidate })
      }
    }
  }
  if ($nameHits.Count -eq 1) { return $nameHits[0] }
  return $null
}

function Select-ActiveWorkbook($apps) {
  $choices = @()
  foreach ($app in $apps) {
    $active = $null
    try { $active = $app.ActiveWorkbook } catch {}
    if ($null -eq $active) { continue }
    $visible = $false
    try { $visible = [bool]$app.Visible } catch {}
    $choices += [pscustomobject]@{ App = $app; Workbook = $active; Visible = $visible }
  }
  $pool = @($choices | Where-Object { $_.Visible })
  if ($pool.Count -eq 0) { $pool = @($choices) }
  if ($pool.Count -eq 0) {
    $running = 0
    foreach ($app in $apps) { $running++ }
    if ($running -eq 0) {
      throw "Excel is not running. Open the workbook, or pass workbookPath to a closed file."
    }
    throw "Excel is open, but no workbook is active. Open a workbook or pass workbookPath."
  }
  if ($pool.Count -gt 1) {
    $labels = @()
    foreach ($item in $pool) {
      $label = ""
      try { $label = [string]$item.Workbook.FullName } catch {}
      if ($label) { $labels += $label }
    }
    throw "More than one Excel window has an active workbook ($($labels -join '; ')). Pass workbookPath."
  }
  return @{ excel = $pool[0].App; workbook = $pool[0].Workbook }
}

function New-OwnedExcel {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $app.AskToUpdateLinks = $false
  $app.ReferenceStyle = 1
  return $app
}

function Open-RequestedWorkbook([bool]$useActive, [string]$workbookPath) {
  $apps = Get-ExcelApplications
  $keep = $null
  try {
    if ($useActive) {
      $selected = Select-ActiveWorkbook $apps
      $keep = $selected.excel
      return @{ excel = $selected.excel; workbook = $selected.workbook; attached = $true; owned = $false }
    }
    if (-not (Test-Path -LiteralPath $workbookPath)) {
      throw "Workbook not found: $workbookPath"
    }
    $found = Find-OpenWorkbook $apps $workbookPath
    if ($null -ne $found) {
      $keep = $found.excel
      return @{ excel = $found.excel; workbook = $found.workbook; attached = $true; owned = $false }
    }
    $app = New-OwnedExcel
    try {
      $opened = $app.Workbooks.Open($workbookPath, 0, $false)
    } catch {
      try { $app.Quit() } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
      throw "Could not open ${workbookPath}. If that file is already open in Excel, omit workbookPath to use the active workbook. $($_.Exception.Message)"
    }
    return @{ excel = $app; workbook = $opened; attached = $false; owned = $true }
  } finally {
    Release-OtherExcel $apps $keep
  }
}

function Assert-LambdaWorkbook($workbook) {
  $full = ""
  try { $full = [string]$workbook.FullName } catch {}
  $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
  if ($ext -and $ext -ne ".xlsx" -and $ext -ne ".xlsm") {
    throw "LAMBDA names need an .xlsx or .xlsm file. The open workbook is $full."
  }
}

try {
  $commandText = [System.IO.File]::ReadAllText($CommandPath, [System.Text.UTF8Encoding]::new($false))
  $command = $commandText | ConvertFrom-Json
  $useActive = $false
  if ($command.PSObject.Properties.Name -contains "useActive" -and $command.useActive) { $useActive = $true }
  if ($command.workbookPath) { $requestedPath = [string]$command.workbookPath }
  if (-not $useActive -and -not $requestedPath) { $useActive = $true }

  $opened = Open-RequestedWorkbook $useActive $requestedPath
  $excel = $opened.excel
  $wb = $opened.workbook
  $attached = [bool]$opened.attached
  $owned = [bool]$opened.owned
  Assert-LambdaWorkbook $wb
  if ($attached) {
    try { $previousReferenceStyle = $excel.ReferenceStyle } catch {}
    try { $excel.ReferenceStyle = 1 } catch {}
  }

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
    try { $resolvedPath = [string]$wb.FullName } catch {}
  }
  if (-not $resolvedPath -and $requestedPath) { $resolvedPath = $requestedPath }

  if ($save -and $null -ne $wb) {
    try {
      $folder = ""
      try { $folder = [string]$wb.Path } catch {}
      if ($attached -and [string]::IsNullOrWhiteSpace($folder)) {
        $saved = $false
        if (-not $message) {
          $message = "Names were written to the open workbook. It has no file path yet, so it was not saved."
        }
      } else {
        if ($attached) {
          $previousAlerts = $excel.DisplayAlerts
          $excel.DisplayAlerts = $false
          try { $wb.Save() } finally { $excel.DisplayAlerts = $previousAlerts }
        } else {
          $wb.Save()
        }
        $saved = $true
      }
    } catch {
      $ok = $false
      $saved = $false
      $message = "Workbook save failed: $($_.Exception.Message)"
    }
  }

  if ($attached -and $null -ne $excel -and $null -ne $previousReferenceStyle) {
    try { $excel.ReferenceStyle = $previousReferenceStyle } catch {}
  }

  if ($owned) {
    if ($null -ne $wb) {
      try { $wb.Close($false) } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) } catch {}
    }
    if ($null -ne $excel) {
      try { $excel.Quit() } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) } catch {}
    }
  } else {
    if ($null -ne $wb) {
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) } catch {}
    }
    if ($null -ne $excel) {
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) } catch {}
    }
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

Write-Result
if (-not $ok) { exit 1 }
