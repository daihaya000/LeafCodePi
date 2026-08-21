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

$exePath = Join-Path $repoRoot "LeafCodePi.exe"

if (-not (Test-Path -LiteralPath $exePath)) {
    # The exe is committed to git, so a missing copy means it was deleted
    # locally: rebuild it (quietly) before failing the shortcut creation.
    & cmd.exe /d /c "call `"$repoRoot\scripts\build-launcher.bat`" /quiet" | Out-Null
}
if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Launcher not found: $exePath (run scripts\build-launcher.bat to build it)"
}

$targetPath = $exePath
# The exe already carries the icon as an embedded Win32 resource (see
# scripts\build-launcher.bat's /win32icon), so point the shortcut at it
# directly rather than the standalone .ico copy above.
$shortcutIconLocation = "$exePath,0"

$shortcutPath = Join-Path $DesktopDir "LeafCodePi.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $repoRoot
$shortcut.WindowStyle = 1
$shortcut.IconLocation = $shortcutIconLocation
$shortcut.Description = "LeafCodePi"
$shortcut.Save()
