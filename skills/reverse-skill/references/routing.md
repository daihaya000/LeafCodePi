# Routing Matrix — 3軸ルーティング行列

対象を3軸で分類し、該当sub-skillを特定する。

## Axis 1 — By Target Type（目標タイプ）

| Target | Sub-skill | 備考 |
|--------|-----------|------|
| APK (Android) | `apk-reverse` | jadx/apktool/frida |
| Binary (ELF/PE/Mach-O) | `ida-reverse` or `radare2` | IDA優先、CLIはr2 |
| JS (frontend) | `js-reverse` | 署名定位/補環境 |
| JS (custom VM/DSL) | `js-reverse` (dsl-vm) | IIFE+switch-case opcode |
| HTTP capture | `pentest-tools` | Burp/Nmap |
| Firmware/IoT | `firmware-pentest` | binwalk/EMBA |
| WASM | `reverse-engineering` | angr/Unicorn |
| macOS/iOS | `mobile-reverse` | class-dump/Objection |
| Game (Unity) | `reverse-engineering` | IL2CPP/dnSpy |
| Memory dump/PCAP | `malware-analysis` | Volatility/tshark |
| Malware | `malware-analysis` | YARA/sandbox |
| OLLVM | `reverse-engineering` | D-810/obpo-plugin |
| Crypto | `reverse-engineering` | IDA/r2 + crypto tools |
| Protocol | `pentest-tools` | custom protocol replay |
| Go/Rust binary | `reverse-engineering` | go-reverse references |
| LLM/Agent | `llm-security` | garak/PyRIT |
| API (REST/GraphQL) | `api-security` | jwt_tool/Burp Autorize |
| Supply chain | `supply-chain-security` | Trivy/Syft/cosign |
| CTF競技 | 各シナリオskill | CTF-Sandbox-Orchestrator相当 |
| Cloud/K8s | `pentest-tools` | cloud metadata/SSRF |
| Windows/AD | `pentest-tools` | Mimikatz/BloodHound |
| Forensics | `malware-analysis` | timeline/DPAPI |
| .NET/C# | `dotnet-reverse` | dnSpyEx/de4dot |
| EDR/AV | `edr-bypass-re` | pe-sieve/SysWhispers3 |
| Patch diff | `patch-diff-exploit` | BinDiff/Diaphora |
| Symbol migration | `binary-diff` | LLM batch compare |

## Axis 2 — By User Intent（ユーザ意図）

| Intent | Sub-skill |
|--------|-----------|
| "DSL VM逆" | `js-reverse` (dsl-vm) |
| "decompile/IDA" | `ida-reverse` |
| "Frida hook" | `apk-reverse` or `mobile-reverse` |
| "find frontend signature" | `js-reverse` |
| "APK unpack" | `apk-reverse` |
| "bypass anti-debug" | `edr-bypass-re` or `apk-reverse` |
| "OLLVM脱混淆" | `reverse-engineering` |
| "symbol migration" | `binary-diff` |
| "port scan/Nmap" | `pentest-tools` |
| "SQL injection/SQLMap" | `pentest-tools` |
| "draw diagram" | (外部 diagram-generator) |
| "write report" | (外部 docs-generator) |
| "red team/HW" | `pentest-tools` + `attack-chain` |
| "BurpSuite" | `pentest-tools` |
| "API security" | `api-security` |
| "pwn/ROP" | `pwn-chain` |
| "Agent not working" | `llm-security` |
| "patch diff/nday" | `patch-diff-exploit` |
| "malware/yara" | `malware-analysis` |
| "firmware extract" | `firmware-pentest` |
| "SBOM/SCA" | `supply-chain-security` |
| ".NET decompile" | `dotnet-reverse` |
| "unlock X / 去除校验" | `edr-bypass-re` or `apk-reverse` |
| "拿flag/crackme" | CTF → 該当シナリオskill |

## Axis 3 — By Toolchain（ツールチェーン）

| Tool | Sub-skill |
|------|-----------|
| IDA Pro | `ida-reverse` |
| radare2 | `radare2` |
| jadx/apktool | `apk-reverse` |
| Frida | `apk-reverse` / `mobile-reverse` |
| GDB | `pwn-chain` / `reverse-engineering` |
| Ghidra | `malware-analysis` / `reverse-engineering` |
| angr/Unicorn/Qiling | `reverse-engineering` |
| D-810/obpo-plugin | `reverse-engineering` (OLLVM) |
| BinDiff/Diaphora | `patch-diff-exploit` |
| pwntools/GEF | `pwn-chain` |
| Nmap/Nuclei/SQLMap | `pentest-tools` |
| Hashcat | `pentest-tools` |
| Metasploit | `pentest-tools` |
| BurpSuite | `pentest-tools` / `api-security` |
| garak/PyRIT | `llm-security` |
| Trivy/Syft | `supply-chain-security` |
| Objection | `mobile-reverse` |
| dnSpyEx/de4dot | `dotnet-reverse` |
| binwalk/EMBA | `firmware-pentest` |
| YARA/Sigma | `malware-analysis` |
| pe-sieve/SysWhispers3 | `edr-bypass-re` |

## Route Not Matched

既存skillに強制適合せず、新skill提案:
- 提案内容: 名前・適用範囲・必要ツールチェーン・既存skillとの関係
- ルーティング失敗自体が新skill提案のシグナル

## Cross-Module Paths

```
APK:        decode → .so解析(ida/r2) → Frida
JS:         Observe → hook → Rebuild → env-patching
DSL VM:     dsl-vm → opcode/const → browser CDP → js-reverse
CTF:        orchestrator → evidence別routing → block時戻る
WebPentest: browser → Burp proxy_history → intruder → report
Firmware:   extract → emulate → fuzz → analyze
Pwn:        recon → vuln → exploit → debug → optimize
Malware:    sandbox → unpack → static → dynamic → IOC
PatchDiff:  diff → root cause → PoC → weaponize
```