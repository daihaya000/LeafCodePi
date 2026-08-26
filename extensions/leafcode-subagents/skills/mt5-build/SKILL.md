---
name: mt5-build
description: MetaTrader 4/5 の MQL4/MQL5 開発を、コンパイル、静的検査、デプロイ、Strategy Tester、レポート解析、ログ確認まで進める。mcp-mt5 / mt5-build MCP サーバーを使うビルド・バックテスト作業で使用する。ライブ取引ではなく、EA開発と検証の依頼で起動する。
license: MIT
compatibility: Windows と MetaTrader 4/5 のインストールが必要。mcp-mt5==0.4.1 のツールを対象とする。
---

# MT5 Build / Backtest Assistant

`PHUICMT/mcp-mt5` の `mt5-build` MCP サーバーを使うための手順。これはブローカーへ接続して注文するサーバーではなく、MetaEditor と Strategy Tester を操作する開発用ハーネスである。ライブ取引は `trading` スキルと `metatrader` サーバーの担当なので混同しない。

## MCP ツールの呼び出し

LeafCodePi では通常、MCP の `mcp` gateway を使う。

```js
mcp({ server: "mt5-build" })
mcp({ search: "compile backtest report", limit: 12 })
mcp({ tool: "env_info", server: "mt5-build", args: {} })
```

`mcp` の検索結果に表示される実際のツール名を優先する。direct tools が有効なセッションでは、そのセッションが公開した名前を使う。サーバーは lazy 接続なので、まず `env_info` で確認する。

## 安全ルール

- `env_info` の `issues` を確認し、問題が残ったままコンパイルやバックテストを開始しない。
- 対象ファイルと作業範囲がユーザーの依頼に含まれる場合だけ、書き込み・デプロイ・バックテストを行う。パスや EA 名を推測しない。
- `compile_and_deploy`、`deploy_ea`、`install_include`、`patch_tester_ini`、`format_mql(write=true)`、`rename_symbol(dry_run=false)`、`extract_function(dry_run=false)` は変更前に対象と変更内容を明示する。最初は dry-run / read-only の操作を選ぶ。
- `run_backtest` と `smoke_test` は MetaTrader terminal を起動し、ファイルを生成・更新する。実行前に設定ファイル、期間、銘柄、モデル、`ShutdownTerminal=1` を確認する。
- `kill_terminal` は対象 edition の terminal を強制終了するため、ユーザーが明示した場合だけ使う。
- MT5 のログイン情報やブローカー認証情報を要求・保存・出力しない。このサーバーはライブ取引認証を行わない。
- テスト用の生成物（`.mt5tmp/`、compile log、tester report）は、依頼がない限りコミットしない。

## 標準ワークフロー

### 1. 環境確認

1. `env_info` を呼ぶ。
2. `edition`、`install`、`data`、`metaeditor`、`terminal`、`mql_root`、`experts_dir`、`issues` を記録する。
3. `issues` がある場合は停止し、`MT5_INSTALL`、`MT5_DATA`、`MT5_TERMINAL_HASH`、`MT5_EDITION` の設定または MetaTrader のインストールを案内する。
4. 複数端末がある場合は `list_terminals` で確認し、必要ならユーザー指定の `select_terminal` を使う。

### 2. ソースと設定の確認

1. `.mq4` / `.mq5` / `.mqh` の絶対パスを確認する。
2. 必要に応じて `extract_inputs`、`resolve_includes`、`find_symbol`、`code_metrics`、`lint_basic`、`check_deprecated` を read-only で実行する。
3. `tester.ini` を使う場合は `validate_tester_ini` を先に実行する。入力値を生成・変更する場合は `gen_tester_inputs` または `patch_tester_ini` の結果を確認する。
4. フォーマットは先に `format_check` を使い、書き込みが依頼された場合だけ `format_mql(write=true)` を使う。

### 3. コンパイル

- 構文だけなら `syntax_check`、通常のビルドなら `compile` を使う。
- `errors` と `warnings`、`returncode`、`log_excerpt` を確認する。
- エラーがある場合はデプロイやバックテストに進まず、エラーのファイル・行・列を示して修正対象を限定する。
- 成功後も警告を無視せず、ユーザーへ報告する。

### 4. デプロイ

ユーザーが明示的に依頼した場合だけ `compile_and_deploy` または `deploy_ea` を使う。出力先が対象 terminal の `Experts/` であること、EA 名、生成された `.ex4` / `.ex5` を確認する。デプロイ前に compile が成功していることを必ず確認する。

### 5. バックテスト

1. `tester.ini` の `Expert`、`Symbol`、`Period`、`Model`、`FromDate`、`ToDate`、`Deposit`、`Visual` を確認する。
2. `validate_tester_ini` が成功していることを確認する。
3. 待機する場合は `ShutdownTerminal=1` を確認し、`run_backtest(wait=true)` を使う。長い処理では依頼された妥当な `timeout_sec` を指定する。
4. 実行後に `read_tester_report` と `tail_log(mode="tester")` を使い、テストが完了したことと runtime error がないことを確認する。
5. コンパイル・デプロイ・起動・ログ検査のどこで失敗したかを分けて報告する。

### 6. 結果比較

ベースラインがある場合だけ `compare_reports` と `regression_check` を使う。最低限、net profit、profit factor、drawdown、trade count、勝率、テスト期間、symbol、timeframe、model を並べる。バックテスト結果を将来利益の保証や金融助言として扱わない。

## ツール選択

| 目的 | ツール |
|---|---|
| 端末・パス確認 | `env_info`, `list_terminals`, `select_terminal` |
| ソース解析 | `extract_inputs`, `resolve_includes`, `find_symbol`, `code_metrics`, `extract_doc` |
| 品質検査 | `lint_basic`, `check_deprecated`, `format_check`, `validate_tester_ini` |
| ビルド | `syntax_check`, `compile` |
| 配布 | `compile_and_deploy`, `deploy_ea`, `install_include`, `list_experts` |
| テスト | `run_backtest`, `smoke_test` |
| 結果・ログ | `read_tester_report`, `tail_log`, `parse_optimization`, `top_passes` |
| 比較・回帰 | `compare_reports`, `regression_check` |
| リファクタ | `rename_symbol`, `extract_function`（既定 dry-run） |
| スナップショット | `snapshot_sources`, `list_snapshots` |

## 報告形式

作業終了時は次を簡潔に報告する。

1. 対象ソース、terminal edition、symbol、timeframe、期間
2. 実行したツールと結果（return code、errors、warnings）
3. デプロイ先、tester report、ログのパス
4. レポート指標と比較結果
5. 未解決の `issues`、環境不足、生成物、次の修正候補

Source: [PHUICMT/mcp-mt5](https://github.com/PHUICMT/mcp-mt5), MIT.
