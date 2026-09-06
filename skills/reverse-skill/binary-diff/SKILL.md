---
name: binary-diff
description: >
  Cross-version binary diffing and symbol migration using automated function
  matching and LLM batch comparison. Trigger on binary diff, symbol migration,
  cross-version diff, function matching, llm binary diff, 符号迁移,
  patch diff, version compare.
---

# Binary Diff — Symbol Migration

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `load binaries` を実行

## 適用範囲
- 同一製品の異 version binary (vuln / patched, 旧版 / 新版) の比較
- Function-level matching: BinDiff / Diaphora
- Unmatched function の LLM batch compare による符号推定
- Symbol propagation: 旧版の関数名・注釈を新版へマップ
- コスト目安: ~1元 / 200 functions (LLM API batch)

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| IDA Pro | yes | disassembly + database export | false |
| BinDiff / Diaphora | yes | function matching | true |
| Python 3.10+ | yes | batch compare script | true |
| PyYAML | yes | prompt/result management | true |
| LLM API | yes | unmatched function semantic compare | false |
| jq | optional | JSON result filtering | true |

## 工作流
1. **load old/new binary (IDA)**
   - 両バイナリを IDA で open, auto-analysis 完了を待つ
   - 型情報 / 関数名を旧版で整備済みであることが望ましい
2. **function match (BinDiff / Diaphora)**
   - BinDiff: `bindiff --primary old.i64 --secondary new.i64 --output diff.BinDiff`
   - Diaphora: IDA メニュー `Edit → Plugins → Diaphora` で export → diff
   - 類似度閾値 0.7 以上を matched とする
3. **unmatched list export**
   - IDA Python で unmatched function の pseudocode / bytes / strings を dump
   ```python
   import idautils, idc, idaapi
   # export function list + pseudocode to YAML
   ```
4. **LLM batch compare**
   - prompt template (参考: `../references/llm-diff-prompt.yaml`):
     ```yaml
     system: You are a reverse engineer comparing two functions.
     user: |
       Function A (old version):
       {old_pseudo}
       Function B (new version):
       {new_pseudo}
       Task: determine if B is a renamed/changed version of A.
       Return JSON: {"match": bool, "confidence": 0-1, "reason": "..."}
     ```
   - batch script で 200 functions / batch, rate limit 制御
5. **symbol propagation**
   - matched / LLM-confirmed 関数に旧版 symbol を付与
   - IDA `set_name(ea, "old_name")` または BinDiff import
6. **verify**
   - 手動サンプリングで symbol migration 精度を確認
   - 誤 match を IDA color / comment でマーク
   - 結果を `../field-journal/precedent-reverse.md` に蓄積

## 按需自举
- ツール不在: BinDiff / Diaphora を手動インストール; LLM API key を設定
- IDA 不在: Ghidra + `version_tracking` tool で代替 (精度低下)
- LLM cost 抑制: まず BinDiff only で high-confidence ペアを埋め、unmatched のみ LLM
- tool-index 不在: `bash ../scripts/refresh-tool-index.sh`

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: N-day root cause → `patch-diff-exploit`; malware variant → `malware-analysis`
- 同级关联: `ida-reverse` (single binary deep analysis), `patch-diff-exploit`

## 任務完了自検
1. 授权明記 (local-sandbox/CTF/owned/書面授权)
2. IDA Pro / BinDiff / Diaphora / Python / LLM API の状態を `tool-index.md` で検証
3. load → match → unmatched → LLM batch → symbol propagation → verify まで実行
4. 発見を `field-journal/precedent-reverse.md` または `_template.md` に蓄積
