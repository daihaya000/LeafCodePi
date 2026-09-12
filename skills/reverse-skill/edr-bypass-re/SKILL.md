---
name: edr-bypass-re
description: >
  EDR防御実装のリバースエンジニアリングとレッドチーム回避研究。 Trigger on edr bypass, edr evasion, syswhispers, sysmon, pe-sieve,
  hook bypass, unhook, 免杀, av bypass, edr reverse, anti-debug bypass.
---

# EDR Bypass RE

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `EDR identify` を実行

## 適用範囲
- EDR/AV の userland hook (ntdll, kernel32, IAT) 調査
- Unhook 技術: direct syscalls, SSN (Syscall Service Number) recovery, DLL refresh
- Telemetry blinding: ETW patch, AMSI bypass, Sysmon config gap
- Injection technique evaluation in lab environment
- Callback object / alert threshold の特定 (EDR チューニング逆分析)
- Snapshot / VM revert で実験を再現可能に保つ
- 商用 EDR の name/version は public 情報源で調査後に実験
- 対象は isolated lab / CTF / owned endpoint / written authorization のみ

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| pe-sieve | yes | detect hooks / implants in running process | true |
| SysWhispers3 | yes | direct syscall stub generator | true |
| Sysmon | lab | telemetry source for verification | false |
| WinDbg | optional | kernel/user debugging | false |
| Process Hacker / System Informer | optional | runtime inspection | false |
| Visual Studio / MinGW | yes | compile PoC | false |

## 工作流
1. **EDR identify**
   - プロセス内ロード DLL 一覧: `tasklist /m`, Process Hacker Modules
   - EDR 製品名・version 特定 (non-destructive recon)
2. **hook survey**
   - `pe-sieve /pid <target> /hooks /shellc`
   - ntdll メモリ比較: on-disk ntdll.dll vs in-memory ntdll `.text`
   - IAT / inline hook 検出: `r2 -A target.exe` → `ii` / `iS`
3. **unhook (direct syscalls)**
   - SysWhispers3 で stub 生成:
     ```bash
     python3 syswhispers.py --preset all -o syscalls_stubs
     ```
   - Visual Studio で `sw3.c` + `payload.c` をコンパイル
   - SSN recovery: `HellHall`, `HellsGate`, `Perun` 手法を選択
4. **telemetry blinding**
   - ETW patch: patch `EtwEventWrite` / `NtTraceEvent` in target process
   - AMSI bypass: 既知 CTF/lab 手法を適用 (memory patch)
   - Sysmon evasion: 除外パス・プロセス名を特定し technique を限定
5. **injection test (lab only)**
   - APC injection, thread hijack, mapping injection などを選択
   - `pe-sieve /pid <target>` で異常が検出されるか確認
   - 検出された場合、technique を分割・再評価
   - 最小実証: `calc.exe` 起動または beacon 通信
6. **verification**
   - EDR console / Sysmon log でアラート有無を確認
   - Process Monitor で suspicious API call (NtCreateThreadEx, NtMapViewOfSection) を確認
   - 成功条件: process 生存 + ペイロード実行 + アラートゼロ

## 按需自举
- ツール不在: `bash ../scripts/bootstrap.sh pe-sieve syswhispers3` (Windows WSL / MSYS2)
- Visual Studio 不在: MinGW-w64 + `x86_64-w64-mingw32-gcc`
- Sysmon 不在: テレメトリ確認を Event Viewer + EDR console のみに限定
- tool-index 不在: `bash ../scripts/refresh-tool-index.sh`

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: malware sample 解析 → `malware-analysis`; kernel driver → `reverse-engineering`
- 同级关联: `pentest-tools` (lateral movement), `reverse-engineering` (anti-analysis)

## 任務完了自検
1. 授权明記 (isolated lab / CTF / owned endpoint / 書面授权)
2. pe-sieve / SysWhispers3 / WinDbg の実パスを `tool-index.md` で検証
3. EDR identify → hook survey → unhook → telemetry blinding → injection test まで実行
4. 発見を `field-journal/precedent-pentest.md` または `_template.md` に蓄積
