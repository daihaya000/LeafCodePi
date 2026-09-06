---
name: bash-safety
description: bash ツール使用時の常駐プロセス・サーバ起動・長時間コマンド・ハングリスクを防ぐ。llama-server / next dev / npm run dev / webpack --watch / --watch / uvicorn / fastapi run / flask run / http-server / python -m http.server / serve 等、終了しないコマンドを含む bash 呼び出しの前に必ず読み込む。watch / serve / server / start 等の語を含む長時間コマンドでもトリガー。
---

# Bash Safety — ハング・常駐プロセス防止

bash ツールは終了を待つ。常駐プロセスを誤ってフォアグラウンドで走らせるとハングし、タイムアウト kill 後も孤児がポートを掴む。本スキルはそのリスクを事前に検知・改竄する。

## 自己診断（実行前に行う）

コマンド文字列内に以下パターンが含まれていないか確認する。含まれていれば必ず「非ブロッキング化」手順を適用。

- サーバ・LLM ローダー: `llama-server`, `llama-server-load`, `ollama serve`, `server`
- Node 開発サーバ: `next dev`, `npm run dev`, `nuxt dev`, `vite`, `webpack serve`
- watch 系: `--watch`, `-w`, `webpack --watch`, `tsc --watch`, `nodemon`
- Python サーバ: `uvicorn`, `fastapi run`, `flask run`, `python -m http.server`, `http-server`, `serve`
- その他常駐: `docker run`（`-d` なし）, `kubectl port-forward`, `tail -f`, `nc -l`, `redis-server`

含まれている場合、**他の作業に進む前にこのコマンドの非ブロッキング化を決める**。

## 非ブロッキング化の方法（優先順）

### Windows（cmd.exe / PowerShell）

1. **cmd**: `cmd /c start "" "scripts\llama-server-load.bat" > log 2>&1`
2. **PowerShell**: `Start-Process -PassThru -FilePath "..."`
   - **警告**: `-RedirectStandardOutput`/`-RedirectStandardError` を PS 5.1 で使うと子終了までブロックするため使わない（検証済み 2026-08-19）
3. Git Bash 起動済みの場合: `nohup ./server.sh > log 2>&1 &`

### macOS / Linux

1. `nohup ./server.sh > log 2>&1 &`
2. `screen -dmS myserver ./server.sh`
3. `tmux new-session -d -s myserver "./server.sh"`

## 起動後の検証

非ブロッキング起動後、すぐに短いヘルスチェックで確認する。**起動コマンド自体を走らせっぱなしにして確認しない**。

- HTTP サーバ: `curl -s http://127.0.0.1:PORT/health` や `curl -I http://127.0.0.1:PORT`
- プロセス存在: `tasklist | findstr llama-server`（Windows） / `pgrep -f llama-server`
- ポート: `netstat -ano | findstr :PORT`（Windows） / `lsof -i :PORT`

## 長時間コマンドの扱い

- bash ツールの実行は基本 **30 秒以内**に収める
- 想定外に長引く場合は `timeout 30 <command>` を使い、30 秒以上かかればキャンセルして手段を見直す
- 30 秒以上かかる検証は tsc/eslint/テスト以外の目的に使わない。必要ならユーザー/ホストに任せる

## 禁止パターン（違反）

以下は実行しない。ハングするか孤児を生む:

- `llama-server-load.bat` や `npm run dev` をそのまま bash ツールで走らせる
- PS 5.1 で `Start-Process ... -RedirectStandardOutput ... -RedirectStandardError ...` を使ってサーバを起動
- 終了しないコマンドを `2>&1` 付きで `cmd /c` だけで走らせる（`start` が必須）
- サーバ起動を「確認」として bash ツールで 30 秒以上走らせる

## 回復手順

すでにフォアグラウンドでサーバを走らせてハングしている場合:

1. 即座にキャンセル（ツールを中断）
2. 孤児プロセスを確認・kill: `taskkill /F /IM llama-server.exe`（Windows） / `pkill -f llama-server`
3. ポートを確認: `netstat -ano | findstr :8081` / `lsof -i :8081`
4. 必要に応じて `taskkill /PID <PID> /F`
5. 正しい非ブロッキング構文に書き直して再実行
