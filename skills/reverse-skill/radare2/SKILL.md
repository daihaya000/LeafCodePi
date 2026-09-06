---
name: radare2
description: >
  radare2 CLI binary reverse engineering skill. Trigger on radare2, r2,
  cli disassembly, binary patch, rabin2, radiff2, open-source RE, quick triage.
---

# radare2

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `r2 -A open` を実行

## 適用範囲
- ELF/PE/Mach-O のCLI静的解析
- 逆アセンブル (`pdf`)、構造体解析 (`pf`)、xrefs (`axt`)
- バイナリパッチ (`wx`)、差分 (`radiff2`)、文字列抽出 (`izz`)
- 手軽なtriage、CTF、headless自動化
- IDA Pro不可環境やlicense-free解析

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| radare2 (r2) | yes | main CLI RE framework | true |
| rabin2 | yes | binary info / symbols / imports | true |
| rasm2 | yes | assemble/disassemble snippets | true |
| radiff2 | yes | binary diffing | true |
| rax2 | optional | base conversion / expressions | true |
| Cutter | optional | GUI frontend | false |

## 工作流
1. **open**: `r2 -A ./target`
   - `-A` は `aaa` 自動解析。大ファイルでは `-A` 時間注意
2. **info**: `iI` (bin info), `ii` (imports), `iS` (sections), `iz` (strings)
3. **analysis**: `aaa` → `afl` (関数リスト) → `s main` → `pdf` (disassemble)
4. **search**: `/x 90 90` (hex), `/ string`, `/r sym.imp.strcmp` (refs)
5. **navigate**: `s <addr>`, `V` visual mode, `vv` graph mode
6. **patch**: `wx 9090 @ <addr>` または `r2 -w ./target` でwriteモード
7. **diff**: `radiff2 -O original patched` で変更箇所確認
8. **export**: `pdg` (ghidra decompile plugin) / `pdc` (r2 pseudo-decompiler)
9. **scripting**: `r2 -q -c 'iz~password;axt @@ str.*' ./target`

## 常用コマンド例
```
r2 -A ./target
[0x00401000]> iI
[0x00401000]> afl~verify
[0x00401000]> s 0x00401234
[0x00401234]> pdf
[0x00401234]> axt @@ 0x00401234
[0x00401234]> wx 9090
```

## 按需自举
- r2不在: `bash ../scripts/bootstrap.sh radare2`
- 解析失速: `e anal.timeout=120` または `-AA` の代わりに段階的解析
- decompile品質不足: `r2ghidra-dec` plugin導入 or `ida-reverse` skillへ委譲

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: decompile深化 → `ida-reverse` ; 動的検証 → `reverse-engineering`
- 同级关联: `ida-reverse` (GUI/commercial), `patch-diff-exploit` (diff→exploit)

## 任務完了自検
1. 授权明記
2. r2/rabin2/rasm2/radiff2 の実パスを `tool-index.md` で検証
3. open → analysis → disassemble → search/patch → export まで実行
4. `field-journal/precedent-reverse.md` に関数アドレス・patch bytes・発見を蓄積
