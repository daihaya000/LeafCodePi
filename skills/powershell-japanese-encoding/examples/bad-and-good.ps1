# BAD: the defaults differ between Windows PowerShell 5.1 and PowerShell 7+.
Get-Content .\input.txt
"日本語" | Out-File .\output.txt
some-command | Set-Content .\result.txt
Import-Csv .\input.csv
Export-Csv .\output.csv
chcp 65001

# GOOD: first document/confirm each source and consumer contract.
$isPwsh7 = $PSVersionTable.PSVersion.Major -ge 6
$input = Get-Content -LiteralPath .\input.txt -Raw -Encoding UTF8 # known UTF-8 input

# Exact UTF-8 no-BOM output across both editions.
[System.IO.File]::WriteAllText(
    (Join-Path $PWD 'output.txt'),
    "日本語`r`n",
    [System.Text.UTF8Encoding]::new($false))

# Excel's required contract is UTF-8 with BOM.
if ($isPwsh7) {
    $rows | Export-Csv -LiteralPath .\excel.csv -NoTypeInformation -Encoding utf8BOM
} else {
    $rows | Export-Csv -LiteralPath .\excel.csv -NoTypeInformation -Encoding UTF8
}

# A CP932 native tool needs a separate, documented byte boundary.
$cp932 = [System.Text.Encoding]::GetEncoding(932)
[System.IO.File]::WriteAllText((Join-Path $PWD 'tool-input.txt'), '日本語', $cp932)
& .\legacy-tool.exe --input .\tool-input.txt
