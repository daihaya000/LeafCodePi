# Creates a Desktop shortcut for LeafCodePi.
# ASCII-only so Windows PowerShell 5.1 parses it without a BOM.
param(
    [string]$DesktopDir = [Environment]::GetFolderPath("Desktop"),
    [string]$IconOutputDir = (Join-Path $env:APPDATA "leafcode-pi")
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $IconOutputDir)) {
    New-Item -ItemType Directory -Path $IconOutputDir -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $DesktopDir)) {
    New-Item -ItemType Directory -Path $DesktopDir -Force | Out-Null
}

$iconJsonPath = Join-Path $repoRoot "host\src\icon.json"
if (-not (Test-Path -LiteralPath $iconJsonPath)) {
    throw "Icon source not found: $iconJsonPath"
}

$iconPath = Join-Path $IconOutputDir "app.ico"
$iconJson = Get-Content -LiteralPath $iconJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$iconBytes = [Convert]::FromBase64String($iconJson.base64)
[System.IO.File]::WriteAllBytes($iconPath, $iconBytes)

$batPath = Join-Path $repoRoot "start.bat"
if (-not (Test-Path -LiteralPath $batPath)) {
    throw "Launcher not found: $batPath"
}

$shortcutPath = Join-Path $DesktopDir "LeafCodePi.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $batPath
$shortcut.WorkingDirectory = $repoRoot
$shortcut.WindowStyle = 7
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "LeafCodePi"
$shortcut.Save()
