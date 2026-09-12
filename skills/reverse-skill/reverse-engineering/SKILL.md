---
name: reverse-engineering
description: >
  コンパイル済み/難読化/パック/VM/WASM/OLLVM対象の汎用リバースエンジニアリング。 Trigger on reverse engineering, 逆向, OLLVM, deobfuscation,
  VM reverse, WASM, angr, symbolic execution, unpack, anti-debug bypass.
---

# Reverse Engineering

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `file type/strings` を実行

## 適用範囲
- コンパイル済みバイナリ (ELF/PE/Mach-O) の汎用RE
- パック・難読化・VM化バイナリ (UPX, VMProtect, custom VM)
- OLLVM制御フロー平坦化の脱混淆 (D-810 / obpo-plugin)
- WebAssembly (WASM) 復元
- Go/Rust/ kernel driver / firmware blob
- anti-debug / anti-vm / anti-dump パターン
- symbolic execution (angr) とemulation (Unicorn/Qiling)

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| file/strings/binutils | yes | triage | true |
| IDA Pro / radare2 | yes | static解析 | false/true |
| GDB + GEF/pwndbg | yes | dynamic debug | true |
| Frida | yes | dynamic instrumentation | true |
| angr | optional | symbolic execution | true |
| Unicorn/Qiling | optional | emulation | true |
| D-810 / obpo-plugin | optional | OLLVM deobfuscation | false |
| GDB | yes | runtime debug | true |

## 工作流
1. **triage**: `file ./target`, `strings -n 8 ./target`, `binwalk ./target`
2. **static**: IDA Pro または radare2 で関数・文字列・importsを抽出
3. **動的**: GDB (`starti`, `b *0x...`, `r`) または Frida で実行時挙動確認
4. **anti-analysis bypass**: ptrace/PrcssEnvFlags/TimingCheckを特定しpatch
5. **symbolic/emulation**: angrでpath explore / Unicornで特定関数のみemulate
   ```python
   import angr
   p = angr.Project('./target', auto_load_libs=False)
   sm = p.factory.simulation_manager(p.factory.entry_state())
   sm.explore(find=lambda s: b"flag" in s.posix.dumps(1))
   ```
6. **OLLVM脱混淆**: D-810 (Ghidra plugin) または obpo-plugin で制御フロー復元
7. **アルゴリズム復元**: 平文→暗号/协议state machine を再実装し、入出力で検証

## anti-analysis パターン対応
| パターン | 対処 |
|----------|------|
| ptrace PT_DENY_ATTACH |  syscall hook / `NOP` patch |
| TLS callback anti-debug |  IDA/x64dbgでTLS callback確認 |
| OLLVM flattening |  D-810 / obpo-plugin / symbolic |
| VMProtect |  Unicorn trace + handlers还原 |
| custom opcode VM |  opcode/const table → dispatcher 対応表 |

## 按需自举
- ツール不在: `bash ../scripts/bootstrap.sh radare2 gdb frida angr`
- D-810/obpo-plugin未導入: 手動Ghidra plugin install or `ida-reverse` skill
- Go/Rust symbol問題: `pwnie/go-re` または `anvill` で型復元検討

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: 深層IDA → `ida-reverse` ; CLI → `radare2` ; JS VM → `js-reverse`
- 同级关联: `ida-reverse`, `radare2`, `apk-reverse`, `dotnet-reverse`, `pwn-chain`

## 任務完了自検
1. 授权明記
2. file/strings/GDB/Frida/angr の実パスを `tool-index.md` で検証
3. static → dynamic → symbolic → 算法復元 まで実行
4. `field-journal/precedent-reverse.md` にanti-analysis手法と復元結果を蓄積
