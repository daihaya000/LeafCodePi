---
name: reverse-skill
description: >
  Reverse engineering / authorized penetration testing / security research
  skill router pack. Use when the user works with APK/binary/JS/firmware/WASM
  analysis, decompilation (IDA/radare2/Ghidra/jadx), Frida hooking, anti-debug
  bypass, OLLVM deobfuscation, CTF challenges, port scanning / Nmap, SQL
  injection / SQLMap, BurpSuite, API security (REST/GraphQL/JWT), pwn / ROP /
  heap exploitation, .NET deobfuscation, malware analysis, firmware extraction,
  patch diffing / N-day, supply chain / SBOM, LLM security / prompt injection,
  EDR bypass research, or any authorized security assessment. Routes to the
  correct scenario sub-skill, bootstraps the toolchain on demand, and
  accumulates findings into a field journal. Authorized use only — assumes
  local sandbox / CTF / owned targets / written authorization.
---

# Reverse Skill — Router Pack

> 逆向 / 渗透 / 安全研究スキルルータ。AI自動ルーティング + 按需ツールチェーン自举 + 経験库自動進化。

## ACTION REQUIRED（読後即時実行）

"理解した" だけの返答は失敗。以下を順次実行せよ:

1. **NOW**: `references/RULES.md` を読む — 全局ルーティング規則（唯一の正）
2. **NOW**: 任務が本skillの適用範囲か確認（権限・CTF/local-sandbox仮定）
3. **NEXT**: `references/routing.md` を読む — 3軸ルーティング行列で対象skill特定
4. **NEXT**: 対象sub-skillの `SKILL.md` を読み、工作流の第1步を実行
5. **ACT**: 停止せず、確認状態で止まらない

## 適用範囲

本router packは以下をカバーする（各々独立sub-skillにルーティング）:

| 対象 | Sub-skill | 主要ツール |
|------|-----------|-----------|
| APK解包・Java逆コンパイル・Frida | `apk-reverse` | jadx, apktool, frida, adb |
| 前端JS署名定位・Node補環境 | `js-reverse` | js-reverse MCP, jshookmcp |
| バイナリ分析（IDA Pro） | `ida-reverse` | idalib-mcp, IDA Pro |
| CLI二進分析 | `radare2` | r2, rabin2, rasm2, radiff2 |
| 汎用RE（コンパイル/難読化/VM） | `reverse-engineering` | GDB, Frida, angr, Unicorn, Qiling |
| .NET/C#託管PE逆向 | `dotnet-reverse` | dnSpyEx, de4dot, ILSpy, dnlib |
| 固件/IoT OWASP FSTM | `firmware-pentest` | binwalk, unblob, EMBA, AFL++ |
| EDR防御実装逆→bypass | `edr-bypass-re` | pe-sieve, SysWhispers3, Sysmon |
| N-day補丁差分→PoC | `patch-diff-exploit` | BinDiff, ghidriff, Diaphora |
| 脆弱点→exploit（栈/堆/内核） | `pwn-chain` | pwntools, GEF/pwndbg, ROPgadget |
| 主动渗透 | `pentest-tools` | Nmap, Nuclei, SQLMap, FFUF, Hashcat |
| REST/GraphQL/WebSocket | `api-security` | jwt_tool, Burp Autorize |
| YARA/Sigma/沙箱/IOC | `malware-analysis` | Ghidra, CAPE, YARA, Sigma, FLOSS |
| Android+iOS | `mobile-reverse` | JADX, Frida, Objection, class-dump |
| OWASP LLM Top10 | `llm-security` | garak, PyRIT, promptfoo |
| SBOM/SCA/CI-CD | `supply-chain-security` | Trivy, Syft, Gitleaks, cosign |
| 跨版本符号迁移 | `binary-diff` | IDA Pro, LLM API |

## ルーティング手順

```
User task
  → references/RULES.md（全局規則・権限確認）
  → references/routing.md（3軸行列: target type / user intent / toolchain）
  → <scenario>/SKILL.md（工作流実行）
  → tools / scripts / MCP
  → report + field-journal 蓄積
```

詳細なルーティング判定は `references/routing.md` を参照。

## 按需自举（On-Demand Bootstrap）

ツールが未インストール時はパスを推測せず、`scripts/bootstrap.sh`（Linux/macOS）または `scripts/bootstrap.ps1`（Windows）を実行して自動インストール。インストール後は `scripts/refresh-tool-index.*` で `references/tool-index.md` を再生成。

bootstrap-manifest.json で21のcapabilityを定義済み。詳細は `scripts/bootstrap-manifest.json`。

## 経験库（Field Journal）

任務完了時は `field-journal/` に知見を蓄積する:

- `field-journal/_template.md` — 新規エントリのテンプレート
- `field-journal/precedent-reverse.md` — 逆向関連の前例
- `field-journal/precedent-pentest.md` — 渗透関連の前例
- `field-journal/precedent-auth.md` — 授权確認の前例

エントリは anonymize し、秘密情報（API鍵・トークン・個人データ）を含めない。

## 任務完了自检

完了宣言前に以下を全て確認:

1. **授权**: 対象がlocal-sandbox/CTF/owned/書面授权のいずれかであることを明記
2. **工具**: 使用ツールの実パスを `tool-index.md` で検証済み
3. **路由**: 対象sub-skillの工作流を最後まで実行
4. **记录**: 発見をfield-journalに蓄積（anonymize済み）

## 安全規則

- 破壊的操作は明示的な指示と授权がない限り実行しない
- 秘密情報をコード・コミット・ログ・field-journalに書かない
- 実環境への攻撃は書面授权がある対象のみ
- CTF/lab解釈を優先し、曖昧な場合は非破壊的初手（hash/file type/strings）から