---
name: ida-reverse
description: >
  IDA Pro binary reverse engineering skill. Trigger on IDA, ida pro,
  decompile binary, idalib, hex-rays, commercial decompiler, ARM/x86 RE.
  Requires an IDA Pro license.
---

# IDA Reverse

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `open binary` を実行

## 適用範囲
- ELF/PE/Mach-O の静的解析・逆コンパイル (Hex-Rays)
- `idalib-mcp` 経由の自動化 (72 tools)
- 関数リスト・xrefs・型復元・アルゴリズム復元
- バイナリdiff / patch / 構造体定義
- cross-skill: APK内.so, firmware, malware 深層解析

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| IDA Pro | yes | GUI/CLI disassembler | false |
| idalib-mcp | yes | MCP automation layer | false |
| Hex-Rays decompiler | yes | C-like pseudocode | false |
| Python 3 / idapython | yes | スクリプト自動化 | true |
| lumina / sigmake | optional | 関数識別 | false |

## 工作流
1. **open binary**: IDA Pro で対象バイナリをロード
   - PE/ELF/Mach-O に応じて processor module と base address を確認
2. **auto-analysis**: `Analyze > Analyze program` または CLI `idat -A -Sanalysis.idc`
3. **関数リスト**: `Shift+F12` strings window → 興味文字列をダブルクリック → xrefs
4. **逆コンパイル**: 目標関数を選択し `F5` (Hex-Rays)
5. **アルゴリズム復元**: pseudocodeから暗号・checksum・协议state machineを読解
   - 型不明時は `Y` で型を設定
6. **スクリプト自動化**: `idalib-mcp` を使い一括処理
   ```python
   import idalib
   ida = idalib.connect()
   for f in ida.functions():
       if "verify" in f.name: print(hex(f.start_ea), f.name)
   ```
7. **検証**: 静的結果をGDB/Frida/angrで動的確認 (`reverse-engineering` skill)

## 按需自举
- IDA未インストール: 手動インストール必須 (commercial license)。`tool-index.md` にパス登録
- idalib-mcp不在: MCP configへの追加手順を表示
- Hex-Rays未購入: pseudo-code不可 → `radare2` skillへ切替検討
- 2回失敗: 手動インストール手順を出力し `field-journal` に記録

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: 動的検証 → `reverse-engineering` ; CLI代替 → `radare2`
- 同级关联: `radare2` (CLI), `patch-diff-exploit` (bindiff), `apk-reverse` (.so解析)

## 任務完了自検
1. 授权明記
2. IDA Pro / idalib-mcp の実パスとlicense状態を `tool-index.md` で検証
3. open → auto-analysis → 関数リスト → decompile → スクリプト自動化 まで実行
4. `field-journal/precedent-reverse.md` に関数アドレス・型・復元アルゴリズムをanonymizeして蓄積
