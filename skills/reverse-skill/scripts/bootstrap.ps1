# bootstrap-reverse.ps1 — On-demand toolchain installer for reverse-skill (Windows)
# Usage: powershell -File scripts\bootstrap.ps1 [-Ids capability_id ...]
# If no -Ids, installs all auto_install=true capabilities.
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$Ids
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Manifest = Join-Path $ScriptDir "bootstrap-manifest.json"
$Platform = "windows"

if (-not (Test-Path $Manifest)) { Write-Error "Manifest not found: $Manifest"; exit 1 }

$json = Get-Content $Manifest -Raw | ConvertFrom-Json

if (-not $Ids -or $Ids.Count -eq 0) {
  $Ids = @($json.capabilities | Where-Object { $_.auto_install -eq $true } | ForEach-Object { $_.id })
}

Write-Host "=== reverse-skill bootstrap ($Platform) ===" -ForegroundColor Cyan
Write-Host "Targets: $($Ids -join ' ')"

$installed = @(); $failed = @()

foreach ($id in $Ids) {
  $cap = $json.capabilities | Where-Object { $_.id -eq $id } | Select-Object -First 1
  if (-not $cap) { Write-Warning "Unknown capability: $id"; continue }

  $cmd = $cap.commands.$Platform
  if (-not $cmd) { $cmd = $cap.commands.all }
  if (-not $cmd) { Write-Host "[SKIP] $id : no install command for $Platform"; continue }

  Write-Host "[INSTALL] $id : $cmd" -ForegroundColor Yellow
  try {
    Invoke-Expression $cmd
    if ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) {
      $installed += $id
      Write-Host "[OK] $id installed" -ForegroundColor Green
    } else {
      $failed += $id
      Write-Host "[FAIL] $id (exit $LASTEXITCODE)" -ForegroundColor Red
    }
  } catch {
    $failed += $id
    Write-Host "[FAIL] $id : $_" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "Installed: $($installed.Count) -> $($installed -join ' ')"
Write-Host "Failed:    $($failed.Count) -> $($failed -join ' ')"
Write-Host ""
Write-Host "Next: run scripts\refresh-tool-index.ps1 to regenerate tool-index.md"