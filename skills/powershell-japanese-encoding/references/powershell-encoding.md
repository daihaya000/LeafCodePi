# PowerShell encoding reference

## Cmdlet encoding meanings

| Edition | `-Encoding utf8` | `utf8BOM` | Important default risk |
| --- | --- | --- | --- |
| Windows PowerShell 5.1 | UTF-8 **with BOM** | Not available | `Out-File` and redirection default to UTF-16LE; `Set-Content` / `Add-Content` use legacy defaults depending on cmdlet/file state |
| PowerShell 7+ | UTF-8 **without BOM** | Available; UTF-8 with BOM | Text cmdlets default to UTF-8 without BOM, but defaults still hide the contract |

Windows PowerShell 5.1 supports named values such as `Unicode`, `UTF7`, `UTF8`, `UTF32`, `ASCII`, `BigEndianUnicode`, `Default`, and `OEM`; it does **not** support PowerShell 7 names such as `utf8BOM`, `utf8NoBOM`, `ansi`, `oem`, or code-page numeric forms. Do not use a PowerShell 7-only encoding token in a 5.1-targeted script.

## File formats

| Format | Default recommendation | Exceptions |
| --- | --- | --- |
| `.ps1` | UTF-8 with BOM for Windows PowerShell 5.1 compatibility when non-ASCII literals are present; UTF-8 without BOM is suitable when PS7-only | Test the actual target host; do not transcode a script while preserving unknown semantics |
| `.bat`, `.cmd` | CP932/OEM only when cmd.exe and its active code page contract require it | UTF-8 batch files are not universally reliable; `chcp` changes console code page, not universal parser behavior |
| JSON, YAML | UTF-8 without BOM unless a documented consumer needs BOM | JSON RFC behavior and parsers vary around BOM; test consumer |
| CSV for Excel | UTF-8 with BOM for modern Excel | Use explicit CP932 only for a verified legacy workflow; CP932 cannot represent emoji and some Japanese characters |
| Generic text | explicit UTF-8 BOM policy | Preserve a known existing encoding and newline convention on edit/append |

## Detect before transform

Byte inspection can reliably detect UTF-8/UTF-16 BOMs. It cannot reliably distinguish BOM-less UTF-8 from CP932 for all byte sequences. Treat a no-BOM file as *unknown* unless its producer contract, metadata, or successful strict decode establishes it. Never decode CP932 bytes as UTF-8 (or the reverse) and re-save: that permanently corrupts the text.

Check line endings separately. Read raw bytes/text and count CRLF versus LF; use the established style, usually CRLF for Windows scripts and data files. Encoding cmdlets do not themselves guarantee preservation of a source file's final newline or line-ending convention.

## Native process settings

* `$OutputEncoding` controls how PowerShell encodes text sent to native standard input; it does not set console display encoding.
* `[Console]::InputEncoding` and `[Console]::OutputEncoding` apply to the .NET console streams; they are not a declaration of a file encoding.
* `chcp 65001` changes cmd.exe's console code page. It does not change PowerShell cmdlet encodings, existing file bytes, an external program's parser, or every pipeline boundary.
* A native tool may ignore console encodings and use ANSI, OEM, UTF-8, a locale setting, or a command option. Follow that tool's documentation and test.

## Test corpus

Always include: `日本語`, `全角ＡＢＣ１２３`, `半角ｶﾅ`, `髙﨑`, `😀`, a supplementary-plane character such as `𠮟`, a Japanese filename such as `日本語😀.txt`, and CRLF/LF checks. CP932 output must deliberately reject or replace unrepresentable characters only when the consumer contract permits it; it cannot round-trip the full corpus.
