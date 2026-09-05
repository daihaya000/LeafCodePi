# MEMORY — LeafCodePi

## 2026-09-05: コミットガードは拡張常時ON・機能だけOFF

### 問題
設定でコミットガードをオフにしても、`agent_settled` 後に `leafcode-commit-gate` follow-up（コミット促し）が送られていた。

### 原因
1. 以前の設定UIは拡張の load/unload（`extensions-state.json` の disabled）を切り替えていた。
2. その後 `leafcode-commit-guard` が WebUI 必須になり、disabled でも常時ロードされる一方、一覧/UIは無効表示のままになり得た。
3. 機能トグル用の設定ファイルが無く、拡張内ゲートが常時動作していた。

### 修正
- **拡張は必須のまま**（無効化不可）
- 機能フラグは `%APPDATA%/leafcode-pi/commit-guard.json`（`{ "enabled": boolean }`、既定 true）
- WebUI: `/api/settings/commit-guard` + エンジン設定のトグル
- `leafcode-commit-guard` は settle 時にフラグを読んで follow-up を抑制
- 古い `extensions-state` の disabled は初回読込で機能OFFへ移行し、disabled キーを掃除
- `settle-followup-claim`: 同一ターンの二重 `prepare` を microtask ラッチで合流

### 関連
- `web/src/lib/commit-guard-config.ts`
- `extensions/leafcode-commit-guard/index.ts`
- `extensions/settle-followup-claim.ts`
- `extensions/leafcode-todowrite`（commit-gate ターン中の Todo 強制スキップは従来どおり）
