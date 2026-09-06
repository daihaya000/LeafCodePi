[CmdletBinding()]
param()

$root = Split-Path -Parent $PSScriptRoot
$checker = Join-Path $root 'scripts/Test-EncodingRisks.ps1'
$roundTrip = Join-Path $root 'scripts/Test-JapaneseRoundTrip.ps1'
$bad = Join-Path $root 'examples/bad-and-good.ps1'

& $roundTrip -OutputDirectory (Join-Path $env:TEMP 'powershell-japanese-encoding-skill-test')

$runner = if ($PSVersionTable.PSVersion.Major -le 5) { 'powershell.exe' } else { 'pwsh' }
$process = Start-Process -FilePath $runner -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $checker, '-Path', $bad, '-TargetVersion', 'WindowsPowerShell51') -Wait -PassThru -NoNewWindow
if ($process.ExitCode -eq 0) { throw 'Risk checker did not detect intentionally bad examples' }

Write-Host 'PASS: skill test cases completed.'
exit 0
