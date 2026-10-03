# LeafCodePi バグ / パフォーマンス検出メモ（ジャンル優先度順）

- 対象: `C:\Users\Daichi\Desktop\LeafCodePi`
- 実施日: 2026-10-03（Asia/Tokyo）
- 方針: 読み取り専用スキャン。コード未修正。
- 整理: 第1〜7巡を **ジャンル優先度順** に再編（ジャンル間は下表、各表内は重大度順）。第8〜10巡追記。
- 件数: 合計 78

## ジャンル優先度

| 優先度 | ジャンル | 件数 | 理由（要約） |
| --- | --- | --- | --- |
| P1 | セキュリティ / 認証 / ACL | 21 | 任意実行・ACL・認証漏れが先 |
| P2 | 並行性 / データ整合 | 13 | データ消失・二重実行・セッション奪取 |
| P3 | エージェント / MCP / ツール | 6 | コア挙動の誤登録・誤委譲・停止不能 |
| P4 | ホスト / 再起動 / トレイ | 5 | Goal Loop ごと落ちる・再起動空振り |
| P5 | パフォーマンス / ホットパス | 18 | ホットパス肥大・SSE・同期 spawn |
| P6 | リソースリーク / プロセス寿命 | 5 | 孤児プロセス・長寿命リーク |
| P7 | ファイル閲覧 / 添付 | 2 | 閲覧範囲の欠け（symlink） |
| P8 | UI / UX | 5 | 操作性・テーマ・保存漏れ |
| P9 | その他 | 3 | 肥大・検索精度など上記外 |

---

## P1 — セキュリティ / 認証 / ACL（21）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 **[修正済 2026-10-03]** | `extensions/leafcode-subagents/src/runs/shared/acceptance.ts`（~1087, 1189–1201） | acceptance verify の `command.cwd` が `path.resolve(defaultCwd, cwd)` のみで、ワークツリー外への `../` 脱出を止めない。`shell: true` で起動するため、検証コマンドがリポジトリ外で任意シェルを実行しうる。 |
| 高 **[修正済 2026-10-03: リモート接続は未設定時にトークンを生成して既定ON。明示的な `enabled: false` は意図的なオプトアウトとして維持]** | `host/src/webui-auth.js`（`ensureWebUiAuth` ~93–100）、`host/src/index.js`（~587） | 既定バインドは Tailscale（loopback 以外）。`webui-auth.json` が無い、または `enabled: false` だと `LEAFCODE_PI_WEBUI_AUTH` を立てない。テールネット（や `0.0.0.0`）からトークン無しで API に届き、プロファイル export・browse・エージェント実行ができる。短いトークン／`?token=` とは別で、認証自体が既定オフ。 |
| 高〜中 **[見送り: /mnt は mountinfo 上の実マウント点のみ。WSL の /mnt/c 等が目的の仕様]** | `browse-drives.ts` (~23)、`dirs/route.ts` (~83–96) | Linux で `/mnt`・`/mnt/*` をドライブ扱いし allowed roots に合流。取り外しボリューム意図が `/mnt` 配下全体閲覧になる。 |
| 高〜中 **[修正済 2026-10-03: 本文ストリームを4KBで打切り、未認証リクエストは共有キーで60回/分に制限（超過429は監査記録しない）。監査追記・trimは非同期化し、10%分をまとめてtrim。read()はmaxLines件に制限]** | `web/src/lib/peer-auth/http.ts`（`readBoundedJson` ~12–17）、`backend/core/peer-auth-serve.mjs`（`gate` ~30–40）、`backend/core/peer-auth-audit.mjs`（~31–48, 68–75） | Peer Bearer認証はWebUIトークンと別管理。認証済みリクエストはgrant単位、未認証は共有キーでプロセス内レート制限。監査JSONL追記・trimは非同期I/O＋非ブロッキングlockで行い、上限超過後の全件trimを10%単位で償却。 |
| 中 **[修正済 2026-10-03: peer import GET/POSTに常時route-level WebUI認証を追加。WebUI auth未設定時は401でprobe/importを拒否]** | `web/src/app/api/peer-auth/import/route.ts`（GET/POST）、`web/src/lib/peer-auth/import.ts`（~45–55）、`backend/core/peer-auth-remote-store.mjs`（~43–49） | peer共有はLAN/Tailscaleを想定するためprivate peer URLは許容。import・一覧probeはpeer Bearerを送る前にroute-levelでWebUI認証を要求し、グローバルauth offでも未認証の発信を拒否。リダイレクトは拒否済み。 |
| 中 **[一部修正 2026-10-03: `/api/settings/tts` PATCH・synthesize・voices probeで標準loopback TTS以外の設定/利用にWebUI認証。outbound redirectも拒否]** | `web/src/app/api/settings/tts/route.ts`（PATCH）、`web/src/app/api/tts/synthesize/route.ts`、`web/src/app/api/settings/tts/voices/route.ts`、`web/src/lib/tts-synthesize.ts`、`extensions/leafcode-tts/index.ts`（~266–278） | AivisSpeech/VOICEVOX標準ポートのloopback root URLのみ未認証利用を許容。その他のURL変更・Web API outboundには認証必須。extension側の直接送信先制御は未対応。 |
| 中 **[修正済 2026-10-03: 相対パス・非ディレクトリ・symlink 脱出を拒否。home / OneDrive / 登録プロジェクト / no-project root の実パス containment を検査。`/local-client` は Origin と local header も検証]** | `host/src/llama-control-server.js`（`/local-client/explorer` ~141–176）、`host/src/open-explorer.js`（~4–89） | パスの許可ルート検査が無く、Explorer 系プロセスに任意パスを渡していた。 |
| 中 **[修正済 2026-10-03: 追記とトリムを同じ withDirectoryLock 内で実行]** | `backend/core/peer-auth-audit.mjs`（~41–48） | 監査 JSONL の追記と 1000 行トリムがプロセス間ロックなし。WebUI と Backend が同時に書くと、read→rename のあいだの行が落ちる。Windows では開いたファイルの rename 失敗でその行自体も捨てる。 |
| 中 **[修正済 2026-10-03: withDirectoryLock で RMW を排他。破損ファイルは上書きせず 500 で中止]** | `backend/core/peer-auth-grants.mjs` (~8, 46–54, 72–93) | プロセス間ロックなし。複数ワーカー RMW でグラント消失。壊れた JSON を空扱い→次保存で既存ドロップ。 |
| 中 **[修正済 2026-10-03]** | `extensions/leafcode-permission-gate/index.ts` (~109–113, 139–144) | セグメント分割が `\|` を切らない。`echo node \| Stop-Process ...` でも node 自己停止扱いになりセッションが落ちる。 |
| 中 | `extensions/leafcode-web-access/ssrf-protection.ts` (~212–224, 237–238, 330–338) | DNS で私設を弾いたあと接続時の再解決を固定しない。`trustEnvProxy` はチェック省略のみで Node fetch にプロキシ強制なし。 |
| 中 **[一部修正 2026-10-03: トークン比較の長さ漏れ解消＋ログイン失敗10回/分のレート制限（X-Forwarded-For 単位）。最短4文字はユーザー承認の仕様として維持（見送り）]** | `host/src/webui-auth.js` (~6)、`web/src/app/api/auth/webui/route.ts` (~12–31)、`webui-auth-shared.ts` (~21) | トークン最短 4 文字・ログインにレート制限なし。長さ違いで比較即抜け→長さも漏れる。 |
| 中 **[修正済 2026-10-03: ACAO を private-network Origin のみ反射・Vary: Origin]** | `web/src/app/api/host-probe/route.ts`（~19–28） | `Access-Control-Allow-Origin: *` と Private Network Access 許可。任意のウェブページが `http://127.0.0.1:<port>/api/host-probe` を読め、ローカルで LeafCodePi が動いているかとプロセス ID を探知できる。 |
| 中 | `web/src/lib/codexbar/chromium-cookies.ts`（decrypt ~98–129） | Windows は v10/v11 AES-GCM のみ。Chrome app-bound（v20）は復号できず自動取得が空になる。 |
| 中 | `web/src/lib/localhost-redirect.ts`（~56–59, 67–76） | ホスト名の最初の `:` で切るので、Tailscale の IPv6 URL は私設アドレス判定に失敗し loopback へ移らない。`location.port` が空（80/443）だとプローブ URL が `http://127.0.0.1:/api/host-probe` になり到達確認も失敗する。 |
| 中 **[見送り: tmpdir はエージェント生成の一時画像表示のための意図的設計。拡張子とマジックバイトで検証済み]** | `web/src/lib/local-image.ts`（~56–58, 79） | タスク画像の許可ルートに `tmpdir()` を足している。ブラウズ許可（ホーム / OneDrive / プロジェクト）より広く、一時フォルダ内の画像をタスク経由で読める。 |
| 中 | `web/src/lib/pi/oauth-callback.ts` (~80) | 戻り先が `localhost` でも接続先は常に `127.0.0.1`。`::1` のみ待ち受けだとリレー不到達。 |
| 中 | `web/src/lib/pi/subagent-runs.ts` (~193–196) | `os.tmpdir()` の `pi-subagents-*` を全部見る。別タスク transcript が混ざる。 |
| 中 **[一部修正 2026-10-03: API では ?token= を拒否。ページは一回限りのサインイン用に維持（リダイレクトで除去）]** | `web/src/proxy.ts`（~11–16, 37–44）、`web/src/lib/webui-auth.ts`（~30–33） | WebUI トークンを `?token=` クエリでも受理。リファラ・アクセスログ・履歴にトークンが残りうる（短いトークン／無レート制限とは別面）。 |
| 低 | `backend/core/mcp-native-config-owner.mjs` (~76–86) | `verify()` から ACL attest を外したのは意図的（Win で毎ターン 1s 超）。準備後の ACL 変更は次の `prepare` まで気づかない。 |
| 低 | `web/src/lib/codexbar/chromium-cookie-crypto.ts` (~149–161) | Linux `secret-tool lookup application <app>` は schema なし。Chrome libsecret とずれると peanuts に落ち、復号が静かに失敗しうる。 |

---

## P2 — 並行性 / データ整合（13）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 **[保留 2026-10-03: 旧所有者がハートビート停止後に奪われたと気づいて実行を止める経路（ownsTaskLease は判定用に配線済みだが停止用ではない）の設計が先に必要]** | `backend/core/task-runtime-lease.mjs` (~85–87, 140–144) | プロセス生存中でもハートビート 60s 停止で mtime だけでリース奪取。旧プロセス停止なし→Code セッション二重化。 |
| 高 **[一部修正 2026-10-03: 生存 PID で起動キー取得に失敗しても stale 扱いにせず経過時間で判定。他者 PID の起動キー取得の同期 powershell（最大1秒）は未対応]** | `extensions/leafcode-subagents/src/missions/workflow-state.ts` (~60–66, 105–113, reclaim ~156–161) | Windows 起動キー取得が同期 `powershell`（timeout 1000ms）。失敗すると生存ロックを stale 扱いで奪う。ロック取得のたびイベントループ停止。 |
| 高 **[一部修正 2026-10-03: mailbox.json の mtime が変わっていたらキャッシュを破棄して再読込。読込と persist の間の極小レースは残る]** | `web/src/lib/bot-intercom.ts` (~157, 430–437, 508–513) | 受信箱キャッシュがプロセスをまたぐ。ツールは Backend・既読 PATCH は Next。後勝ちの `persistMailbox` が相手の既読／メッセージを戻せる。 |
| 高〜中 **[一部修正 2026-10-03: anthropic と openai-codex(CLI/Pi) を single-flight 化、persist 失敗時はメモリ内トークンを使用、pi-auth.ts は atomic 書き込み＋破損ファイルは上書きせず中止。プロセス間の refresh 競合は未対応]** | `web/src/lib/codexbar/providers/anthropic.ts`（`persistTokens` ~105–120、`tryRefreshTokens` ~123–145）、`openai-codex.ts`（`persistTokens` ~122、refresh 後 `loadAuth`）、`web/src/lib/codexbar/pi-auth.ts`（`writeBackPiOAuthTokens` ~182–214） | 使用量取得の OAuth refresh に single-flight が無い。IdP が refresh token を回したあと、CLI 側 `persistTokens` は書き込み失敗を握りつぶしてから古いファイルを読み直すので、新しい refresh だけが消える。Pi の `auth.json` はロック内でも `writeFileSync` で、クラッシュで全プロバイダ分が欠ける。並行ポーリングで同じ refresh を二度使うと、後勝ちが無効トークンを残す。 |
| 中 **[見送り 2026-10-03: 比較はキャッシュ値の in-place 変異を検知して fresh を返す防御も兼ねる。ハッシュ比較に替えると変異済み値を返しうる]** | `backend/core/app-store.mjs`（`#readStore` ~51） | キャッシュミス時にストア全体を `JSON.stringify` 同士で比較。大きな projects/tasks だと毎回 O(n) の二重シリアライズ。 |
| 中 **[修正済 2026-10-03: archiveOverflow が history 末尾 256KB の既存 id をスキップ（再アーカイブで二重化しない）]** | `backend/core/room-store.mjs` (~104–110)、`web/src/lib/rooms.ts` (~169–171) | `history.jsonl` 追記後に room JSON。後段失敗で次回同じメッセージ再アーカイブ→履歴二重。 |
| 中 **[一部修正 2026-10-03: 時刻で stale な行と incarnation を持たない行では同期 probe を省略。他者 PID の probe 自体は残る（テストは Windows の EPERM で 12/13 失敗し変更前後で同一）]** | `extensions/leafcode-memory/src/store/atomic-lock-coordinator.ts` (~91–97, 161) | 競合中 `tryAcquire` が Windows で毎回同期 powershell（timeout 500ms）。 |
| 中 **[一部修正 2026-10-03: atomic 書き込み化。プロセス間ロックは未対応]** | `web/src/lib/accounts.ts` (~227–230) | `accounts.json` が素の `writeFileSync`。並行作成／並び替えでロストアップデートしうる。 |
| 中 **[一部修正 2026-10-03: withDirectoryLock で Web 側 RMW を排他。Pi 本体など外部書き込みはロックしない]** | `web/src/lib/agents.ts`（`updateAgentOverride` ~347–376） | `~/.pi/agent/settings.json` を read→改変→atomic rename するがプロセス間ロック無し。同時の agent override／他書き込みとロストアップデートし、`packages` 等の他キーを戻しうる。 |
| 中 **[修正済 2026-10-03: 取得から 2 時間超は PID が生きていても放棄扱い（hardStaleMs）]** | `web/src/lib/bot-code-session-lock.ts` (~49–51) | PID 生存中は古くても奪えない。固まった所有者／PID 再利用でロック残留。 |
| 中 **[修正済 2026-10-03: ロック内の updateRoomHandoffs で重複を再判定し同一レシートを返す]** | `web/src/lib/room-runtime.ts` (~616–669) | handoff 重複判定がロック外。同時 tool call で二重登録→二重起動しうる。 |
| 中 **[修正済 2026-10-03: withDirectoryLock で RMW を排他]** | `web/src/lib/skills.ts`（`setSkillsEnabled` ~285–291） | `skills-state.json` も RMW＋atomic のみでロック無し。並行トグルで片方の無効化が消える。 |
| 低 **[見送り 2026-10-03: 起動後は別端末でログを追う設計。二重起動は Host 側の host.lock（host/src/index.js、既存 PID が生きていれば即終了）が担う。npm install 失敗は launcher.log に残る]** | `scripts/launch-linux.sh`（~19–22） | `.desktop` 起動は `nohup setsid start.sh &` で即成功終了。二重起動や `npm install` 失敗を待たず、PID も残さない。 |

---

## P3 — エージェント / MCP / ツール（6）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 **[修正済 2026-10-03: factory の Promise を順序通り返してローダに await させる]** | `backend/core/mcp-native-session.mjs` (~29–32)、`mcp-native-extensions.mjs` (~233) | native MCP factory が `async` なのに `await` していない。登録失敗が未処理 rejection。`tool_search` / `excludeTools` より遅れて登録されうる。 |
| 高 **[修正済 2026-10-03: 汎用キーワード一致時も SDK 検索を併走し結果を併記]** | `web/src/lib/pi/deferred-tools.ts`（当時 ~82–89） | `tool_search` の `query` に `search` / `web` / `fetch` / `bash` などが入ると MCP 検索へ委譲しない。`"search issues"` が `web_search` 扱いになる。 |
| 中 **[一部修正 2026-10-03: resolveAutoAgent / resolveRoomOpener に signal オプション追加、POST /api/tasks は req.signal を伝播。room-runtime・harness 等の他の呼び出し元は未対応]** | `auto-agent.ts` (~55–64, 357–369)、`room-opener.ts` (~43–47, 144–157)、呼び出し `room-runtime.ts` (~425) | 呼び出し元 AbortSignal 無し。送信取消／Room 停止でもルーター呼び出しが止まらない。 |
| 中 **[修正済 2026-10-03: キャッシュキーに最終メッセージの usage 数値を追加]** | `web/src/lib/pi/harness.ts` (~1423–1449) | context 使用量キャッシュが「末尾同一参照のまま usage だけ増加」を見落とす。 |
| 中 **[確認済・現状該当せず 2026-10-03: setActiveToolsByName は bindExtensions(session_start) より前に実行される（harness.ts 3894 → 3574）]** | `web/src/lib/pi/harness.ts` (~3872–3881) | `createAgentSession` 直後の `setActiveToolsByName(initialActive)` が、`session_start` で有効化した codemode / direct MCP を静的 loadout に戻して消しうる。 |
| 中 **[一部修正 2026-10-03: microtask 開始時に自分がまだ現行セッションか確認し、置換・取消済みなら run しない。専用テストは未追加]** | `web/src/lib/pi/harness.ts` (~6732–6748) | ログインはプロセス全体で1本。次開始で前を cancel しても積済 microtask が `runtime.login` を呼び、同時ログインで loopback 衝突しうる。 |

---

## P4 — ホスト / 再起動 / トレイ（5）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 **[修正済 2026-10-03: onRestartHostBlocked で Goal Loop 実行中は 409]** | `host/src/llama-control-server.js` (~333–341)、`host/src/index.js` (~779–802, 1148–1149) | `POST /restart/host` は Goal Loop 拒否を見ずに `quit()`。`backendService.stop()` で実行中ループごと落とす。Backend 再起動だけガード。 |
| 中 **[一部修正 2026-10-03: Windows 再起動スクリプトが起動15秒後にロック不在なら1回だけ再起動。Linux 経路は未対応]** | `host/src/host-restart.js` (~11–18)、`index.js` (~972–975) | ロック残存でも約 120 回待ったあと起動。旧ホスト生存なら新プロセス即終了し、202 再起動が空振り。 |
| 中 **[修正済 2026-10-03: 取得失敗は fail-closed、接続拒否のみ許可]** | `host/src/index.js` (~651–669)、`llama-control-server.js` (~301, 321) | Backend 無し WebUI 再起動は active 取得失敗でも許可（fail-open）。Backend 側は失敗時拒否。 |
| 中 **[修正済 2026-10-03: ロック mtime が 6 時間超なら PID に関わらず放棄扱い]** | `shared/pi-dependencies.mjs`（`piDepsLockHeld` ~19–40、`assertPiDependencyVersions` ~82）、`host/src/pi-update.js`（`acquireDepsLock` ~72–79） | 依存ロックの生存判定は `kill(pid, 0)` が ESRCH のときだけ放棄。Windows の EPERM や PID 再利用は生存扱いで `.leafcode-pi-deps.lock` を消さない。残ると Pi 同期も Host 起動ゲートも「同期が未完了」で拒否し続ける。mtime による期限は無い。 |
| 低 **[一部修正 2026-10-03: stat は初回と 64 書き込みごとの再同期のみ。世代は .1 のみ・並行書き込み握りつぶしは未対応]** | `host/src/log-file.js` (~36–52) | 追記前に毎回 `statSync`。世代は `.1` のみ。並行書き込みは握りつぶす。 |

---

## P5 — パフォーマンス / ホットパス（18）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 | `web/src/components/shell/TaskPanesContext.tsx`（~426–448）、`web/src/lib/bot-sidebar-store.ts`（~24–30, 59–60） | Bot/Room タブの整理がサイドバー取得前の空スナップショットで走る。開いている `/bots/...` を「一覧に無い」とみなして閉じ、URL 同期で別画面へ飛ばしうる。取得失敗時も空のままなので復活しない。 |
| 高〜中 | `BotView.tsx` (~623–796)、`TaskView.tsx` (~1201–1619, mount ~3031) | SSE に `active` ガード無し。裏ペインでも EventSource が残り、分割タブぶん接続増。 |
| 中 | `web/src/components/bot/RoomView.tsx`（`active` ~143、SSE effect ~274–332） | Room の EventSource は `active` を見ず、依存が `[id]` だけ。裏の Room ペインでも接続と再接続が残る。Bot/Task の SSE ガード無しとは別画面。 |
| 中 **[一部緩和 2026-10-03: 走査エントリ上限 20000 を追加。許可ルート検査は、ルート外のモデル置き場を壊すため未対応]** | `web/src/app/api/llama-server/models/route.ts`（GET ~110–146、`collect` ~76–108） | `dir` は browse 許可ルートを見ず、危険文字が無ければ任意の絶対パスを `readdirSync` で深さ 2 まで同期走査する。`statSync` はディレクトリの symlink を追跡する。遅い共有や巨大ツリーで BFF がブロックし、ワークスペース外の `.gguf` 名も返る。 |
| 中 **[一部修正 2026-10-03: web 側 tts-synthesize に 60s タイムアウトと 64MB 上限。CLI 側（leafcode-tts）の並列起動・tmp wav 残りは未対応]** | `web/src/app/api/tts/synthesize/route.ts`（~34–37）、`web/src/lib/tts-synthesize.ts`（~56–72, 82–90）、`extensions/leafcode-tts/index.ts`（~237–242, 266–281） | 合成 fetch にタイムアウトも応答サイズ上限も無い（話者一覧だけ 2.5 秒）。ハングしたエンジンが BFF を掴む。CLI 側はチャンクごとに合成を先に並列起動し、全文 wav を `os.tmpdir()` の `leafcode-tts-<pid>-<n>.wav` へ書く。再生失敗時は削除されない。 |
| 中 **[一部修正 2026-10-03: Content-Length と file.size を事前検査し 413。宣言なしの chunked 本文と export 同時保持は未対応]** | `web/src/app/api/profile/route.ts`（POST ~46–51）、`web/src/lib/profile.ts`（`MAX_ARCHIVE_BYTES` ~18, `importProfileWithBackup` ~444） | 256MB 上限の検査より前に `file.arrayBuffer()` で全体をメモリへ載せる。それより大きいアップロードで BFF が先に落ちる。取り込みは現行プロファイルの export も同時に抱える。 |
| 中 **[一部修正 2026-10-03: ドライブ列挙を 10 秒キャッシュ＋同時呼び出しの共有。Quick Access は従来どおり]** | `dirs/route.ts` (~94)、`browse-drives.ts` (~40–46) | browse GET ごとにドライブ列挙。Win は PowerShell（Quick Access のみ 10s キャッシュ）。 |
| 中 | `extensions/leafcode-goal-loop/index.ts` (~681–708) | 状態 rename が EPERM/EBUSY のとき空ループで最大 ~250ms ビジーウェイト。OneDrive 掴みと重なるとスケジューラ停止。 |
| 中 | `extensions/leafcode-subagents/src/workflows/chat-progress.ts`（~28–54, 74–78） | `resolveWorkflowChatProgress` が parent/workflow それぞれで最大 3 回の同期 `git`（合計最大 6 `spawnSync`）。ワークフロー開始のたびにイベントループを止める。 |
| 中 | `native-supervisor-channel.ts` (~25, 328–351, 701–709) | `CHANNEL_POLL_MS`（最短 250ms）で全 channel `readdirSync`。 |
| 中 | `scripts/web-build-mirror.mjs` (~105–114) | size+mtime 一致でも毎回フルバイト比較。 |
| 中 | `web/src/app/api/tasks/[id]/events/route.ts` (~266–325) | ローカル runtime・別ワーカー所有時、2 秒ごとに task detail とメッセージ全ページを SSE。 |
| 中 | `web/src/lib/direct-session.ts` (~387–411)、`bots/sidebar/route.ts` (~37)、`Sidebar.tsx` (~1706–1708) | mtime 変化で Bot ごとに最大 ~4MB 読込→`buildSessionContext`→末尾1件。ストリーム中 12s poll で重い。 |
| 中 **[緩和 2026-10-03: 上限を 128M→32M 文字へ縮小]** | `web/src/lib/git.ts`（`GIT_MAX_OUTPUT_CHARS` ~14, 87–95） | git stdout/stderr を拒否前に最大約 128MiB 文字までヒープへ連結。巨大 diff で BFF が先にメモリ圧迫される。 |
| 中 | `web/src/lib/llama-server-load.ts`（~16, 69–87）、`web/src/app/api/llama-server/ensure-loaded/route.ts` | `POST /api/llama-server/ensure-loaded` がモデル load 待ちで最大約 180 秒ブロック。Next BFF ワーカーを長時間占有しうる。 |
| 中 | `web/src/lib/pi/bot-code-relay.ts`（`requests` ~292–297、`codeTasksForOrigin` ~687–689） | Room SSE 相当で 2 秒ごとにメンバー数ぶん outbox 全 JSON を `readdir` + `readFileSync`。リレー tick / idle reaper でも同様。 |
| 中 | `web/src/lib/pi/messages.ts` (~183–195) | UI 射影が画像 base64 を data URL のまま保持。長い画像セッションの snapshot／SSE が肥大。 |
| 中 **[一部修正 2026-10-03: GPU 皆無の環境は2回空だったら30秒間スキップ。CPU 温度の PowerShell 再起動は未対応]** | `web/src/lib/sysmon-usage.ts` (~141–147, 625–628) | GPU 空なら `nvidia-smi` と PowerShell を即再起動。CPU 温度はキャッシュミス（~3s）ごとに `Add-Type` 付き PowerShell。 |

---

## P6 — リソースリーク / プロセス寿命（5）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 | `extensions/leafcode-memory/src/handlers/child-process-watchdog.mjs` (~12–15) | Linux で子を `detached`。watchdog SIGKILL だと孫が残る。 |
| 中 | `extensions/leafcode-subagents/src/runs/background/owned-process-tree.ts`（~70–78） | Windows はプロセスグループ非対応で単一 PID に SIGTERM 相当のみし、`unknown/unsupported-platform` を返す。子プロセスが孤児になりうる（Linux の detached 孫問題とは別経路）。 |
| 中 | `host/src/translation-service.js`（stop ~445–459, install ~755–785）、`index.js` (~1143) | 翻訳 install の `installProc` が stop／host 終了で kill されない。タイムアウトなし。 |
| 中 | `web/src/lib/pi/harness.ts` (~1334, 1381–1418) | `throughputByStartedAt` / `toolStartedAt` / `toolEndedAt` に delete 無し。partial output 全文保持。長いセッション／abort でリーク。 |
| 中 **[見送り 2026-10-03: 「最新の読み上げを優先して直前を止める」意図的な単一再生。並行再生は音声が重なるため]** | `web/src/lib/tts-playback.ts` (~82–152) | プロセス全体シングル。分割表示で片方の読み上げがもう片方を abort。 |

---

## P7 — ファイル閲覧 / 添付（2）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 **[修正済 2026-10-03: mtime を lstat に変更し symlink を追跡しない]** | `web/src/app/api/diff/files/route.ts`（~187–192） | untracked の読み取りは symlink を避けているが、mtime 付与は全ファイルで `statSync`（リンク追跡）。ワークツリー内の symlink が外部やパイプを指すと、mtime が外へ漏れ、同期 stat が BFF をブロックしうる。コメントの「lexical isUnder でワークスペース内」は追跡後の実体を見ていない。 |
| 低 | `dirs/route.ts` (~108–111) | symlink／junction ディレクトリを落とすので配下が見えない。 |

---

## P8 — UI / UX（5）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 **[一部修正 2026-10-03: Bot 未取得時は一度取得してからミュート判定。分割ペインでの二重通知は未対応]** | `web/src/components/BotRoutineNotifier.tsx`（~22–28）、`web/src/lib/notify.ts`（`isRoutineRunHandledInline` ~71–76） | ミュート判定がサイドバーのスナップショット依存。一覧が空（取得前や失敗）だと Bot が見つからず、`notificationsEnabled: false` でも完了音とデスクトップ通知を出す。インライン抑止は pathname が `/bots/<id>` のときだけで、分割ペインで Bot を開いていても二重に鳴りうる。 |
| 低 | `Composer.tsx` (~324–338)、`composer-references.ts` (~70–82) | キャレット末尾だと本文全体がクエリ。デバウンス無しで全候補走査。 |
| 低 **[修正済 2026-10-03: light→dark→oyster→system を循環]** | `web/src/app/layout.tsx`（~36）、`web/src/components/ui.tsx`（~577–587） | `themes` に `oyster` と `system` があるのに、切替は `resolvedTheme === "dark"` だけ。oyster / system からは常に light か dark の固定値になり、元の指定へ戻れない。 |
| 低 **[修正済 2026-10-03: アンマウント時に未保存レイアウトを flush]** | `web/src/components/shell/TaskPanesContext.tsx`（~505–517） | ペイン保存は 500ms デバウンス。アンマウント時にタイマーを消すだけで書き出さないので、分割直後に離れるとレイアウトが残らない。 |
| 低 **[修正済 2026-10-03: 深さ6上限と一部ディレクトリ除外。symlink は Dirent で非追跡]** | `web/src/lib/agents.ts`（`discoverInDir` ~209–216） | エージェント `.md` 探索が深さ・サイクル制限なしの再帰。深い木やジャンクションで一覧が重く／スタックしうる。 |

---

## P9 — その他（3）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 **[一部修正 2026-10-03: relay state の期限切れ envelope と孤立 claims を発行時に掃除。claim ごとの全件 parse/整形書き込みは未対応]** | `backend/core/room-relay.mjs` (~67–94)、`room-store.mjs` (~77–96) | consumed envelope / claims が TTL 後も残る。claim ごとに全件 parse＋整形書き込みで単調増加。 |
| 中 | `web/src/app/api/bots/rooms/[id]/events/route.ts` (~137–170) | Backend 所有時、Room を開いている間 2 秒間隔で room 再読込＋pending HTTP。 |
| 低 **[一部修正 2026-10-03: 一致語数で順位付け。OR の再現率・DB 再オープン/全表スキャンは仕様どおり未対応]** | `web/src/lib/memory-search.ts` (~38–47) | 複数語は AND ではなく `LIKE` OR。そのたびに DB 再オープン＋全表スキャン。 |
