---
name: powershell-japanese-encoding
description: Windowsで日本語テキスト・UTF-8・BOM・CP932・Excel・cmd・外部CLIが絡むPowerShell/batch/CSV/JSON/YAML・テキストファイル処理の作成・確認・不具合調査のときに使う。
---

# PowerShell Japanese Encoding

Treat encoding as a contract between the producer, PowerShell runtime, and consumer. Do not infer it merely from a Japanese Windows locale, `chcp 65001`, or a file extension.

## Required workflow

1. Identify `$PSVersionTable.PSVersion.Major`, the input file's actual encoding/BOM and newline style, and every consumer (Excel, cmd.exe, an external CLI, or another program).
2. If any of those facts are unknown and the choice changes behavior, ask: **target application, PowerShell version, and file consumer**. Do not make a blind mechanical rewrite.
3. Choose an explicit encoding contract using [references/powershell-encoding.md](references/powershell-encoding.md). Preserve an existing file's encoding and CRLF/LF unless an intentional migration is agreed.
4. Generate version-aware code. In Windows PowerShell 5.1, `utf8` means UTF-8 **with BOM**; in PowerShell 7+, it means UTF-8 **without BOM**. Use `utf8BOM` only on PowerShell 7+ and use .NET `UTF8Encoding` when one source must control BOM exactly across both versions.
5. For native-process text, configure `$OutputEncoding`, `[Console]::InputEncoding`, and `[Console]::OutputEncoding` only when the target process's expected encoding is known. They are separate settings. `chcp 65001` alone does not configure file cmdlets or all native-process boundaries.
6. Run the static checker and the round-trip test after generating or changing encoding-sensitive code. Review warnings; do not suppress them without documenting the contract.

## Decision table

| Consumer / intent | Recommended contract |
| --- | --- |
| PowerShell 7+, modern tool, JSON/YAML/config | UTF-8 without BOM; `-Encoding utf8` |
| Windows PowerShell 5.1 UTF-8 config / JSON / YAML | .NET UTF-8 without BOM writer; do not use `-Encoding utf8` if BOM is forbidden |
| Excel CSV (modern Excel reliably recognizes UTF-8) | UTF-8 with BOM; PS7 `Export-Csv -Encoding utf8BOM`, PS5.1 `Export-Csv -Encoding UTF8` |
| Excel / legacy Japanese tooling that requires ANSI | CP932 explicitly (`-Encoding Default` in PS5.1 only, or .NET code page 932); verify unsupported characters and delimiters |
| Existing text file | detect/preserve its known encoding and newline convention; do not append with a different encoding |
| Native CLI that documents UTF-8 | configure the native boundary to UTF-8 explicitly, then test with Japanese and emoji |
| Native CLI that documents CP932 | use CP932 bytes / console settings for that boundary; never send UTF-8 by assumption |

`Default` means the active ANSI code page in Windows PowerShell 5.1 and is not a portable declaration of CP932. It is inappropriate when the contract specifically requires CP932 or code-page stability.

## Safe patterns

### Version-aware UTF-8 writer with explicit BOM control

```powershell
function Write-Utf8Text {
    param([string] $Path, [string] $Text, [bool] $WithBom = $false)
    $encoding = [System.Text.UTF8Encoding]::new($WithBom)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}
```

### Read only after declaring the source contract

```powershell
# Input is known UTF-8 without BOM.
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8

# Input is a known CP932 export. On both editions use an explicit .NET reader.
$cp932 = [System.Text.Encoding]::GetEncoding(932)
$text = [System.IO.File]::ReadAllText($path, $cp932)
```

### CSV for Excel

```powershell
if ($PSVersionTable.PSVersion.Major -ge 6) {
    $rows | Export-Csv -LiteralPath $path -NoTypeInformation -Encoding utf8BOM
} else {
    # Windows PowerShell 5.1 UTF8 writes a BOM.
    $rows | Export-Csv -LiteralPath $path -NoTypeInformation -Encoding UTF8
}
```

### Native command boundary

```powershell
# Apply only after confirming that tool.exe expects UTF-8 text.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8NoBom
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
& tool.exe --input $path
```

For a byte-exact native interface, avoid a PowerShell text pipeline and use redirected files or .NET streams with the documented encoding.

## Mandatory review findings

Flag these as risks, not automatic fixes: bare `Get-Content`, `Set-Content`, `Add-Content`, `Out-File`, `Import-Csv`, or `Export-Csv`; an `Out-File` default; `chcp 65001` offered as the only remedy; native-process pipelines; CP932 assumptions; appending to an existing unknown file; and CSV emitted without an Excel/consumer decision.

Run:

```powershell
pwsh -NoProfile -File scripts/Test-EncodingRisks.ps1 -Path .	arget
pwsh -NoProfile -File scripts/Test-JapaneseRoundTrip.ps1
```

Use `powershell.exe` as well when Windows PowerShell 5.1 compatibility is required. See [examples/bad-and-good.ps1](examples/bad-and-good.ps1) and the full matrix in [references/powershell-encoding.md](references/powershell-encoding.md).
