# Start the leafcode-tts Qwen3-TTS HTTP server on Windows ROCm/HIP.
# Copy local.rocm.example.json to local.rocm.json and edit it first.
# This script stays ASCII-only; Japanese paths/text live in that JSON (UTF-8).
# Default: stays resident with a tray icon that owns the server process.
# Use -NoTray to start the server and exit immediately.

param([switch]$NoTray)

$ErrorActionPreference = "Stop"
$script:venvPython = Join-Path $env:LOCALAPPDATA "leafcode-tts-venv\Scripts\python.exe"
$launcher = Join-Path $PSScriptRoot "launch_logged.py"
$configPath = Join-Path $PSScriptRoot "local.rocm.json"
$script:log = Join-Path $env:TEMP "leafcode-tts-server.log"
$script:trayLog = Join-Path $env:TEMP "leafcode-tts-tray.log"

function Write-Tray([string]$message) {
  $line = (Get-Date -Format "HH:mm:ss") + " " + $message
  Add-Content -LiteralPath $script:trayLog -Value $line -Encoding UTF8
  Write-Host $message
}

Set-Content -LiteralPath $script:trayLog -Value "" -Encoding UTF8
if (-not (Test-Path -LiteralPath $script:venvPython)) { throw "venv not found: $script:venvPython" }
if (-not (Test-Path -LiteralPath $configPath)) { throw "config not found: $configPath" }

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath ([string]$config.refAudio))) { throw ("reference wav not found: " + $config.refAudio) }

$env:QWEN3_TTS_MODEL = [string]$config.model
$env:QWEN3_TTS_DEVICE = [string]$config.device
$env:QWEN3_TTS_REF_AUDIO = [string]$config.refAudio
$env:QWEN3_TTS_REF_TEXT = [string]$config.refText
$env:QWEN3_TTS_LANGUAGE = [string]$config.language
# Ambient PORT may belong to another app (LeafCode WebUI uses 3010), so always take the JSON value.
$env:PORT = [string]$config.port
$env:MIOPEN_GEMM_ENFORCE_BACKEND = "hipblaslt"
$env:LEAFCODE_TTS_LOG = $script:log

Remove-Item -LiteralPath $script:log -Force -ErrorAction SilentlyContinue
$script:server = Start-Process -PassThru -FilePath $script:venvPython -ArgumentList @($launcher) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
$script:url = "http://127.0.0.1:" + $env:PORT + "/v1/audio/speech"
Write-Tray ("pid=" + $script:server.Id)
Write-Tray ("url=" + $script:url)
Write-Tray ("log=" + $script:log)

if ($NoTray) { return }

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  # Own console window would otherwise sit in the taskbar; the tray icon replaces it.
  Add-Type -Name TrayWin -Namespace LeafCode -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@
  $console = [LeafCode.TrayWin]::GetConsoleWindow()
  if ($console -ne [IntPtr]::Zero) { $null = [LeafCode.TrayWin]::ShowWindow($console, 0) }

  $iconPath = Join-Path $PSScriptRoot "..\..\..\scripts\launcher\app.ico"
  if (Test-Path -LiteralPath $iconPath) {
    $icon = New-Object System.Drawing.Icon $iconPath
  } else {
    $icon = [System.Drawing.SystemIcons]::Application
  }

  $script:tray = New-Object System.Windows.Forms.NotifyIcon
  $script:tray.Icon = $icon
  $script:tray.Text = "leafcode-tts " + $env:PORT
  $script:tray.Visible = $true
  $script:tray.BalloonTipTitle = "leafcode-tts"
  $script:tray.BalloonTipText = "Loading model on " + $env:QWEN3_TTS_DEVICE
  $script:tray.ShowBalloonTip(3000)

  # Menu handlers only kill the server; the poll loop below notices and exits.
  # A Windows.Forms.Timer tick never fires from a -File script, so do not rely on one.
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $null = $menu.Items.Add("Open log", $null, { Start-Process notepad.exe $script:log })
  $null = $menu.Items.Add("Copy URL", $null, { Set-Clipboard -Value $script:url })
  $null = $menu.Items.Add("-")
  $null = $menu.Items.Add("Stop server", $null, {
    if (-not $script:server.HasExited) {
      & taskkill.exe /PID $script:server.Id /T /F | Out-Null
    }
  })
  $script:tray.ContextMenuStrip = $menu

  Write-Tray "tray ready"
  # Exit with the server so the icon never outlives the process it represents.
  while (-not $script:server.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 200
  }
  Write-Tray ("server exited with code " + $script:server.ExitCode)
} catch {
  Write-Tray ("tray failed: " + $_.Exception.Message)
  throw
} finally {
  if ($script:tray) {
    $script:tray.Visible = $false
    $script:tray.Dispose()
  }
}
