# refresh-tool-index.ps1 — Detect installed tools and regenerate tool-index.md/json
[CmdletBinding()]
param()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$IndexMd = Join-Path (Split-Path $ScriptDir) "references\tool-index.md"
$IndexJson = Join-Path (Split-Path $ScriptDir) "references\tool-index.json"

$tools = @('jadx','apktool','frida','adb','r2','rabin2','rasm2','radiff2','gdb','pwntools','ropgadget','nmap','nuclei','sqlmap','ffuf','hashcat','binwalk','yara','trivy','syft','garak','python3')

$lines = @()
$lines += "# Tool Index (auto-generated)"
$lines += ""
$lines += "> Generated: $(Get-Date -Format 'o')"
$lines += "> Do not edit manually — run scripts\refresh-tool-index.ps1 to regenerate."
$lines += ""
$lines += "| Tool | Available | Path |"
$lines += "|------|-----------|------|"

$json = @{ generated = (Get-Date -Format 'o'); tools = @{} }

foreach ($t in $tools) {
  $cmd = Get-Command $t -ErrorAction SilentlyContinue
  if ($cmd) {
    $lines += "| $t | yes | $($cmd.Source) |"
    $json.tools[$t] = @{ available = $true; path = $cmd.Source }
  } else {
    $lines += "| $t | no | — |"
    $json.tools[$t] = @{ available = $false; path = $null }
  }
}

$lines -join "`n" | Set-Content -Path $IndexMd -Encoding UTF8
$json | ConvertTo-Json -Depth 5 | Set-Content -Path $IndexJson -Encoding UTF8
Write-Host "[OK] tool-index regenerated: $IndexMd" -ForegroundColor Green