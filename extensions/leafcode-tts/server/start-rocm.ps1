# Start the leafcode-tts Qwen3-TTS HTTP server on Windows ROCm/HIP.
# Copy local.rocm.example.json to local.rocm.json and edit it first.
# This script stays ASCII-only; Japanese paths/text live in that JSON (UTF-8).
# Default: stays resident with a tray icon that owns the server process.
# Use -NoTray to start the server and exit immediately.

param([switch]$NoTray)

$ErrorActionPreference = "Stop"
$venvPython = Join-Path $env:LOCALAPPDATA "leafcode-tts-venv\Scripts\python.exe"
$launcher = Join-Path $PSScriptRoot "launch_logged.py"
$configPath = Join-Path $PSScriptRoot "local.rocm.json"
$log = Join-Path $env:TEMP "leafcode-tts-server.log"

if (-not (Test-Path -LiteralPath $venvPython)) { throw "venv not found: $venvPython" }
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
$env:LEAFCODE_TTS_LOG = $log

Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
$p = Start-Process -PassThru -FilePath $venvPython -ArgumentList @($launcher) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
$url = "http://127.0.0.1:" + $env:PORT + "/v1/audio/speech"
Write-Host ("pid=" + $p.Id)
Write-Host ("url=" + $url)
Write-Host ("log=" + $log)
Write-Host "First start downloads models; poll /v1/health until ok."

if ($NoTray) { return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$iconPath = Join-Path $PSScriptRoot "..\..\..\scripts\launcher\app.ico"
if (Test-Path -LiteralPath $iconPath) {
  $icon = New-Object System.Drawing.Icon $iconPath
} else {
  $icon = [System.Drawing.SystemIcons]::Application
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = "leafcode-tts " + $env:PORT
$tray.Visible = $true
$tray.BalloonTipTitle = "leafcode-tts"
$tray.BalloonTipText = "Loading model on " + $env:QWEN3_TTS_DEVICE
$tray.ShowBalloonTip(3000)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$null = $menu.Items.Add("Open log", $null, { Start-Process notepad.exe $log })
$null = $menu.Items.Add("Copy URL", $null, { Set-Clipboard -Value $url })
$null = $menu.Items.Add("-")
$null = $menu.Items.Add("Stop server", $null, {
  if (-not $p.HasExited) { & taskkill.exe /PID $p.Id /T /F | Out-Null }
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu

# Exit with the server so the icon never outlives the process it represents.
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 2000
$watch.Add_Tick({
  if ($p.HasExited) {
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$watch.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $tray.Visible = $false
  $tray.Dispose()
}
