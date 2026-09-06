[CmdletBinding()]
param([string] $OutputDirectory = (Join-Path $env:TEMP 'powershell-japanese-encoding-test'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$text = "日本語|全角ＡＢＣ１２３|半角ｶﾅ|髙﨑|😀|𠮟`r`n次の行"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$utf8Bom = [System.Text.UTF8Encoding]::new($true)

function Assert-Equal { param($Expected, $Actual, [string] $Name) if ($Expected -cne $Actual) { throw "${Name}: round-trip failed" } }
function Assert-Bytes { param([byte[]] $Actual, [byte[]] $Expected, [string] $Name) if ($Actual.Length -ne $Expected.Length) { throw "${Name}: byte count differs" }; for ($i = 0; $i -lt $Actual.Length; $i++) { if ($Actual[$i] -ne $Expected[$i]) { throw "${Name}: bytes differ at $i" } } }

$noBomPath = Join-Path $OutputDirectory '日本語😀-utf8-nobom.txt'
[System.IO.File]::WriteAllText($noBomPath, $text, $utf8NoBom)
Assert-Equal $text ([System.IO.File]::ReadAllText($noBomPath, $utf8NoBom)) 'UTF-8 without BOM'
$noBom = [System.IO.File]::ReadAllBytes($noBomPath)
if ($noBom.Length -ge 3 -and $noBom[0] -eq 0xEF -and $noBom[1] -eq 0xBB -and $noBom[2] -eq 0xBF) { throw 'UTF-8 no-BOM output unexpectedly has a BOM' }

$bomPath = Join-Path $OutputDirectory '日本語😀-utf8-bom.csv'
[System.IO.File]::WriteAllText($bomPath, $text, $utf8Bom)
Assert-Equal $text ([System.IO.File]::ReadAllText($bomPath, $utf8Bom)) 'UTF-8 with BOM'
Assert-Bytes (([System.IO.File]::ReadAllBytes($bomPath))[0..2]) ([byte[]](0xEF, 0xBB, 0xBF)) 'UTF-8 BOM'

$lfPath = Join-Path $OutputDirectory '改行LF.txt'
[System.IO.File]::WriteAllText($lfPath, "日本語`n次の行`n", $utf8NoBom)
if (([System.IO.File]::ReadAllText($lfPath, $utf8NoBom)) -match "`r`n") { throw 'LF file was changed to CRLF' }

$cp932 = [System.Text.Encoding]::GetEncoding(932, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
$cp932Text = '日本語|全角ＡＢＣ１２３|半角ｶﾅ|髙﨑'
$cp932Path = Join-Path $OutputDirectory '日本語-cp932.txt'
[System.IO.File]::WriteAllText($cp932Path, $cp932Text, $cp932)
Assert-Equal $cp932Text ([System.IO.File]::ReadAllText($cp932Path, $cp932)) 'CP932 representable corpus'
try { [void]$cp932.GetBytes('😀'); throw 'CP932 incorrectly accepted emoji' } catch [System.Text.EncoderFallbackException] { }

[pscustomobject]@{ PowerShell = $PSVersionTable.PSVersion.ToString(); OutputDirectory = $OutputDirectory; Result = 'PASS' } | Format-List
