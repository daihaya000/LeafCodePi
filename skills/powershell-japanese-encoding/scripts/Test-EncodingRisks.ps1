[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [ValidateSet('Auto', 'WindowsPowerShell51', 'PowerShell7')]
    [string] $TargetVersion = 'Auto'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Add-Finding {
    param([string] $File, [int] $Line, [string] $Rule, [string] $Message)
    [pscustomobject]@{ File = $File; Line = $Line; Rule = $Rule; Message = $Message }
}

function Get-TextFiles {
    param([string] $Candidate)
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return Get-Item -LiteralPath $Candidate }
    Get-ChildItem -LiteralPath $Candidate -File -Recurse | Where-Object {
        $_.Extension -in '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.csv', '.json', '.yaml', '.yml', '.txt'
    }
}

$resolvedTarget = if ($TargetVersion -eq 'Auto') {
    if ($PSVersionTable.PSVersion.Major -le 5) { 'WindowsPowerShell51' } else { 'PowerShell7' }
} else { $TargetVersion }
$findings = New-Object System.Collections.Generic.List[object]

foreach ($file in @(Get-TextFiles -Candidate $Path)) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $hasUtf8Bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $hasUtf16Bom = $bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))
    if ($file.Extension -eq '.ps1' -and $resolvedTarget -eq 'WindowsPowerShell51' -and -not $hasUtf8Bom -and -not $hasUtf16Bom) {
        $findings.Add((Add-Finding $file.FullName 0 'PS1-BOM' 'Windows PowerShell 5.1 対象の非ASCII .ps1 は UTF-8 BOM を検討してください。'))
    }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $lines = $text -split "`r?`n", 0
    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        $number = $index + 1
        if ($line -match '(?i)\b(Get-Content|Set-Content|Add-Content|Out-File|Import-Csv|Export-Csv)\b' -and $line -notmatch '(?i)\s-Encoding\s+') {
            $findings.Add((Add-Finding $file.FullName $number 'EXPLICIT-ENCODING' 'エンコーディング指定がありません。既存ファイル・PowerShell版・利用先を確認して明示してください。'))
        }
        if ($line -match '(?i)\bOut-File\b' -and $line -notmatch '(?i)\s-Encoding\s+') {
            $findings.Add((Add-Finding $file.FullName $number 'OUT-FILE-DEFAULT' 'Out-File の既定値に依存しています。PS 5.1/7 で契約を明示してください。'))
        }
        if ($resolvedTarget -eq 'WindowsPowerShell51' -and $line -match '(?i)-Encoding\s+(utf8BOM|utf8NoBOM|ansi|oem|[0-9]{3,5})\b') {
            $findings.Add((Add-Finding $file.FullName $number 'PS51-UNSUPPORTED-ENCODING' 'この -Encoding 値は Windows PowerShell 5.1 で使えません。分岐または .NET Encoding を使用してください。'))
        }
        if ($line -match '(?i)\bchcp\s+65001\b') {
            $findings.Add((Add-Finding $file.FullName $number 'CHCP-ONLY' 'chcp 65001 は cmd.exe のコードページのみです。ファイル・$OutputEncoding・コンソール・CLI契約を個別に確認してください。'))
        }
        if ($line -match '(?i)\$(OutputEncoding)|\[Console\]::(InputEncoding|OutputEncoding)' -and $line -match '(?i)\b(Get-Content|Set-Content|Out-File|Export-Csv)\b') {
            $findings.Add((Add-Finding $file.FullName $number 'BOUNDARY-CONFUSION' 'コンソール/ネイティブ境界の設定とファイルcmdletのエンコーディングを混同していないか確認してください。'))
        }
        if ($line -match '(?i)\bExport-Csv\b' -and $line -notmatch '(?i)utf8BOM|UTF8|Default|932|CP932') {
            $findings.Add((Add-Finding $file.FullName $number 'CSV-CONSUMER' 'CSVのBOM/CP932選択が不明です。Excelまたは利用先の契約を確認してください。'))
        }
        if ($line -match '(?i)\b(Add-Content|Set-Content)\b' -and $line -match '\|') {
            $findings.Add((Add-Finding $file.FullName $number 'PIPE-TEXT-BOUNDARY' 'パイプの文字列化と出力エンコーディングを確認してください。ネイティブ出力はbyte契約を検証してください。'))
        }
        if ($line -match '(?i)\b(\w+\.exe|\w+-command)\b.*\|\s*(Set-Content|Out-File)\b') {
            $findings.Add((Add-Finding $file.FullName $number 'NATIVE-PIPE' '外部CLIの出力をPowerShell文字列として保存しています。CLIの出力コードページ、BOM、改行を確認してください。'))
        }
        if ($line -match '(?i)\b(Add-Content)\b') {
            $findings.Add((Add-Finding $file.FullName $number 'APPEND-PRESERVATION' '追記前に既存ファイルのエンコーディング、BOM、CRLF/LFを確認してください。'))
        }
    }
}

$report = $findings | Sort-Object File, Line, Rule | Format-Table -AutoSize | Out-String
if ($report.Trim()) { Write-Host $report }
if ($findings.Count -gt 0) { exit 1 }
