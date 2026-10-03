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
| 中 **[修正済 2026-10-03: 標準loopback以外のURL変更にWebUI認証を要求しallowCustomUrlを保存。extensionは未許可custom URL・redirectを拒否]** | `web/src/app/api/settings/tts/route.ts`（PATCH）、`web/src/lib/tts-config.ts`、`web/src/app/api/tts/synthesize/route.ts`、`web/src/app/api/settings/tts/voices/route.ts`、`web/src/lib/tts-synthesize.ts`、`extensions/leafcode-tts/index.ts`（~167–224, 287–297） | AivisSpeech/VOICEVOX標準ポートのloopback root URLは未認証利用可。その他のURLは認証済みPATCHがallowCustomUrlを保存した場合のみextensionが送信し、手動tts.json設定では同フラグの明示opt-inが必要。カスタムprivate TTSは意図した機能として維持。 |
| 中 **[修正済 2026-10-03: 相対パス・非ディレクトリ・symlink 脱出を拒否。home / OneDrive / 登録プロジェクト / no-project root の実パス containment を検査。`/local-client` は Origin と local header も検証]** | `host/src/llama-control-server.js`（`/local-client/explorer` ~141–176）、`host/src/open-explorer.js`（~4–89） | パスの許可ルート検査が無く、Explorer 系プロセスに任意パスを渡していた。 |
| 中 **[修正済 2026-10-03: 追記とトリムを同じ withDirectoryLock 内で実行]** | `backend/core/peer-auth-audit.mjs`（~41–48） | 監査 JSONL の追記と 1000 行トリムがプロセス間ロックなし。WebUI と Backend が同時に書くと、read→rename のあいだの行が落ちる。Windows では開いたファイルの rename 失敗でその行自体も捨てる。 |
| 中 **[修正済 2026-10-03: withDirectoryLock で RMW を排他。破損ファイルは上書きせず 500 で中止]** | `backend/core/peer-auth-grants.mjs` (~8, 46–54, 72–93) | プロセス間ロックなし。複数ワーカー RMW でグラント消失。壊れた JSON を空扱い→次保存で既存ドロップ。 |
| 中 **[修正済 2026-10-03]** | `extensions/leafcode-permission-gate/index.ts` (~109–113, 139–144) | セグメント分割が `\|` を切らない。`echo node \| Stop-Process ...` でも node 自己停止扱いになりセッションが落ちる。 |
| 中 **[修正済 2026-10-03: trustEnvProxyでEnvHttpProxyAgentを使用し、検証済みIPをproxy接続先へ固定。NO_PROXYはdirect pin]** | `extensions/leafcode-web-access/ssrf-protection.ts` (~190–390)、`extensions/leafcode-web-access/utils.ts` (`isProxyBypassedUrl` ~255)、`extensions/leafcode-web-access/extract.ts` (`fetchAuthenticatedRemoteUrl` ~170–195) | 通常・認証付きfetchの全hopでDNS検査を維持。proxy hopはdispatcher originを検証済みIPに書き換え、元Host/TLS SNIを保持。NO_PROXY対象は検証済みIPへ直接接続し、ローカルDNS解決失敗はfail-closed。HTTP/HTTPS・redirect・cookie・NO_PROXYをローカル試験済み。 |
| 中 **[見送り 2026-10-03: 比較の長さ漏れを対策し失敗制限を追加。最短4文字はユーザー承認仕様として維持]** | `host/src/webui-auth.js` (~6)、`web/src/app/api/auth/webui/route.ts` (~12–31)、`web/src/lib/webui-auth.ts` (~12–17)、`web/src/lib/webui-auth-shared.ts` (~20–27) | 最短4文字の許容はユーザー承認仕様。Node比較はSHA-256＋`timingSafeEqual`、Edge比較はexpected長を走査して長さ差を畳み込む。ログイン失敗はX-Forwarded-For単位で10回/分に制限。比較と429・成功後リセットのテストあり。 |
| 中 **[修正済 2026-10-03: ACAO を private-network Origin のみ反射・Vary: Origin]** | `web/src/app/api/host-probe/route.ts`（~19–28） | `Access-Control-Allow-Origin: *` と Private Network Access 許可。任意のウェブページが `http://127.0.0.1:<port>/api/host-probe` を読め、ローカルで LeafCodePi が動いているかとプロセス ID を探知できる。 |
| 中 **[見送り 2026-10-03: App-Boundは別アプリによるcookie復号を防ぐChromeのセキュリティ境界。v20は通常DPAPIへ渡さず警告し、自動取込非対応を維持]** | `web/src/lib/codexbar/chromium-cookies.ts`（~40–50, 107–140, 307–344） | Googleの[説明](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html)と[Chromium IElevator IDL](https://chromium.googlesource.com/chromium/src/%2B/0fdbaef65b9ade5730c98d5af4fe57ece28f3341/chrome/elevation_service/elevation_service_idl.idl)はElevation Serviceで呼出元アプリを検証し、別アプリからの復号を拒否する設計を明記。通常DPAPIへの誤送信を防ぐ処理は`chromium-cookies.test.ts`で確認済み。v20非対応警告を追加。|
| 中 **[修正済 2026-10-03: IPv6 hostnameの角括弧を正規化。URL APIでprobeを生成しscheme/port維持]** | `web/src/lib/localhost-redirect.ts`（~23–28, 55–70）、`web/src/lib/localhost-redirect.test.ts` | 裸・角括弧付きIPv6のULA判定とdefault portで空port delimiterを生成しないprobe URLを回帰テスト。probeは現在originを基準にし、protocolとportを保持。 |
| 中 **[見送り: tmpdir はエージェント生成の一時画像表示のための意図的設計。拡張子とマジックバイトで検証済み]** | `web/src/lib/local-image.ts`（~56–58, 79） | タスク画像の許可ルートに `tmpdir()` を足している。ブラウズ許可（ホーム / OneDrive / プロジェクト）より広く、一時フォルダ内の画像をタスク経由で読める。 |
| 中 **[修正済 2026-10-03: localhostはIPv4接続拒否時のみIPv6 loopbackへ再試行。DNS解決は引き続き不使用]** | `web/src/lib/pi/oauth-callback.ts`、`web/src/lib/pi/oauth-callback.test.ts` | localhost callbackにIPv4 listenerがない場合、127.0.0.1の`ECONNREFUSED`後に`::1`へ再試行。callback URLがIP literalなら従来どおり該当familyへ固定。IPv6-only listenerの回帰テストあり。 |
| 中 **[修正済 2026-10-03: child transcript初回レコードへ親sessionのSHA-256 keyを記録。tempはkey一致のみ列挙し、旧形式・所有者不明を除外]** | `web/src/lib/pi/subagent-runs.ts`、`extensions/leafcode-subagents/src/shared/child-transcript.ts` | `os.tmpdir()` の `pi-subagents-*` を全部走査する。別タスク transcript が混ざる。 |
| 中 **[修正済 2026-10-03: `?token=` は認証に使わずページURLから除去。one-time sign-in は `/login#token=...` に移行し、client がPOST前にfragmentを履歴から削除。APIは引き続きquery tokenを拒否]** | `web/src/proxy.ts`、`web/src/app/login/LoginForm.tsx`、各回帰テスト | WebUI tokenをURL queryで受理するとreferer・access log・履歴へ漏れうる。fragment方式ではtokenをHTTP URLに含めず、旧query付きページも認証前に除去する。 |
| 低 **[見送り 2026-10-03: ACLはprepare時・書込み時にattest。毎回verifyで同期再検査するとWindowsのイベントループを1秒超停止するため、ACL変更の検知遅延は次のprepare/書込みまで許容]** | `backend/core/mcp-native-config-owner.mjs` (~76–86) | `verify()` の高頻度ACL再検査は性能コストに見合わない。準備後に起きたACL変更は次の `prepare` または書込み時に検知する残余リスク。 |
| 低 **[修正済 2026-10-03: application属性lookupに加え、旧Chromium v1の`xdg:schema`も検索してからpeanutsへfallback。sync/async回帰テスト追加]** | `web/src/lib/codexbar/chromium-cookie-crypto.ts`、extension側コピー、`chromium-cookies.test.ts` | `application`属性を持たない旧v1 keyring itemを取得できず、Safe Storage keyを`peanuts`扱いして復号に失敗する場合がある。 |

---

## P2 — 並行性 / データ整合（13）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 **[一部修正 2026-10-03: heartbeat通知に加えagent_start/tool_execution_startでもtokenを再確認。失効時は旧LiveRuntimeのpromptを無効化し、abortBash→session.abort→破棄]** | `backend/core/task-runtime-lease.mjs`、`web/src/lib/task-runtime-lease.ts`、`web/src/lib/pi/harness.ts`、`web/src/lib/pi/task-fork.ts`、`extensions/leafcode-subagents/src/shared/fork-context.ts`、`extensions/leafcode-subagents/src/runs/foreground/execution.ts`、`extensions/leafcode-subagents/src/runs/foreground/subagent-executor.ts`、`extensions/leafcode-subagents/src/shared/types.ts` | lease奪取後の新規turn/toolを止め、BashへAbortSignalを送る。SessionManager.appendMessageは全roleでlease所有権を再確認。appendCustomMessageEntry/appendCustomEntry/appendCompaction/appendContextEdit/appendSessionInfo/appendLabelChange/branchWithSummary/createBranchedSessionはlease所有権を確認する。task-forkは別SessionManagerでの分岐中source task leaseを取得し、active leaseや競合時は拒否する。leafcode-subagentsのfork-contextは親SessionManagerのlease assertionを分岐生成・fallback write・sanitize rewrite直前に確認する。alignForkedSessionCwdによる後続のcwd書換えも親lease assertionで保護する（assert/write間の競合窓と、assert後に開始済みの同期writeは巻戻せない）。既にappend済みのentryやwriteFile開始済み処理は巻戻せず、branch()/resetLeaf()のin-memory leaf変更、fork-context以外で別に開いたSessionManagerを使うextension書込み、AbortSignalに従わないextension writeと共有副作用を避けて省略したextension cleanupが残る。 |
| 高 **[一部修正 2026-10-03: 生存 PID で起動キー取得に失敗しても stale 扱いにせず経過時間で判定。他者 PID の起動キー取得の同期 powershell（最大1秒）は未対応]** | `extensions/leafcode-subagents/src/missions/workflow-state.ts` (~60–66, 105–113, reclaim ~156–161) | Windows 起動キー取得が同期 `powershell`（timeout 1000ms）。失敗すると生存ロックを stale 扱いで奪う。ロック取得のたびイベントループ停止。 |
| 高 **[一部修正 2026-10-04: persistMailbox が書込直前にディスクをマージし、他プロセスのメッセージと後の既読マーカーを保全。原子書き込み自体と完全な排他は未対応]** | `web/src/lib/bot-intercom.ts`（~157, 430–437, 508–513） | 受信箱キャッシュがプロセスをまたぐ。ツールは Backend・既読 PATCH は Next。後勝ちの `persistMailbox` が相手の既読／メッセージを戻せる。 |
| 高〜中 **[一部修正 2026-10-04: anthropic と openai-codex(CLI/Pi) の token refresh を共通の lock file 機構でプロセス間でも直列化（stale な lock は回収、30秒で諦めて unlocked 実行）。pi-auth.ts は atomicWriteText と mkdir lock を実装済みのため変更なし]** | `web/src/lib/codexbar/providers/anthropic.ts`（`persistTokens` ~105–120、`tryRefreshTokens` ~123–145）、`openai-codex.ts`（`persistTokens` ~122、refresh 後 `loadAuth`）、`web/src/lib/codexbar/pi-auth.ts`（`writeBackPiOAuthTokens` ~182–214） | 使用量取得の OAuth refresh に single-flight が無い。IdP が refresh token を回したあと、CLI 側 `persistTokens` は書き込み失敗を握りつぶしてから古いファイルを読み直すので、新しい refresh だけが消える。Pi の `auth.json` はロック内でも `writeFileSync` で、クラッシュで全プロバイダ分が欠ける。並行ポーリングで同じ refresh を二度使うと、後勝ちが無効トークンを残す。 |
| 中 **[見送り 2026-10-03: 比較はキャッシュ値の in-place 変異を検知して fresh を返す防御も兼ねる。ハッシュ比較に替えると変異済み値を返しうる]** | `backend/core/app-store.mjs`（`#readStore` ~51） | キャッシュミス時にストア全体を `JSON.stringify` 同士で比較。大きな projects/tasks だと毎回 O(n) の二重シリアライズ。 |
| 中 **[修正済 2026-10-03: archiveOverflow が history 末尾 256KB の既存 id をスキップ（再アーカイブで二重化しない）]** | `backend/core/room-store.mjs` (~104–110)、`web/src/lib/rooms.ts` (~169–171) | `history.jsonl` 追記後に room JSON。後段失敗で次回同じメッセージ再アーカイブ→履歴二重。 |
| 中 **[一部修正 2026-10-04: 他プロセスの incarnation probe を 30秒 TTL でメモ化し、同期 powershell の反復起動を回避。テストは Windows の EPERM で 12/13 失敗し変更前後で同一]** | `extensions/leafcode-memory/src/store/atomic-lock-coordinator.ts`（~91–97, 161） | 競合中 `tryAcquire` が Windows で毎回同期 powershell（timeout 500ms）。 |
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
| 中 **[一部修正 2026-10-04: handleRoomPrompt / runRoomConversation / prepareAutoAgentForGoalLoop が signal を渡し、POST /api/bots/rooms/[id]/prompt が req.signal を伝播。Goal Loop のルーターは routing owner 失効時に abort]** | `auto-agent.ts` (~55–64, 357–369)、`room-opener.ts` (~43–47, 144–157)、呼び出し `room-runtime.ts` (~425) | 呼び出し元 AbortSignal 無し。送信取消／Room 停止でもルーター呼び出しが止まらない。 |
| 中 **[修正済 2026-10-03: キャッシュキーに最終メッセージの usage 数値を追加]** | `web/src/lib/pi/harness.ts` (~1423–1449) | context 使用量キャッシュが「末尾同一参照のまま usage だけ増加」を見落とす。 |
| 中 **[確認済・現状該当せず 2026-10-03: setActiveToolsByName は bindExtensions(session_start) より前に実行される（harness.ts 3894 → 3574）]** | `web/src/lib/pi/harness.ts` (~3872–3881) | `createAgentSession` 直後の `setActiveToolsByName(initialActive)` が、`session_start` で有効化した codemode / direct MCP を静的 loadout に戻して消しうる。 |
| 中 **[一部修正 2026-10-04: microtask 開始時に自分がまだ現行セッションか確認し、置換・取消済みなら run しない。専用テストを追加]** | `web/src/lib/pi/harness.ts` (~6732–6748) | ログインはプロセス全体で1本。次開始で前を cancel しても積済 microtask が `runtime.login` を呼び、同時ログインで loopback 衝突しうる。 |

---

## P4 — ホスト / 再起動 / トレイ（5）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 **[修正済 2026-10-03: onRestartHostBlocked で Goal Loop 実行中は 409]** | `host/src/llama-control-server.js` (~333–341)、`host/src/index.js` (~779–802, 1148–1149) | `POST /restart/host` は Goal Loop 拒否を見ずに `quit()`。`backendService.stop()` で実行中ループごと落とす。Backend 再起動だけガード。 |
| 中 **[一部修正 2026-10-04: Linux 経路も builder へ寄せ、ロック待ちに上限（既定1200回×100ms）と起動後のgrace 判定による1回だけの再起動を追加。POSIX 実地テストは未実施]** | `host/src/host-restart.js` (~11–18)、`index.js` (~972–975） | ロック残存でも約 120 回待ったあと起動。旧ホスト生存なら新プロセス即終了し、202 再起動が空振り。 |
| 中 **[修正済 2026-10-03: 取得失敗は fail-closed、接続拒否のみ許可]** | `host/src/index.js` (~651–669)、`llama-control-server.js` (~301, 321) | Backend 無し WebUI 再起動は active 取得失敗でも許可（fail-open）。Backend 側は失敗時拒否。 |
| 中 **[修正済 2026-10-03: ロック mtime が 6 時間超なら PID に関わらず放棄扱い]** | `shared/pi-dependencies.mjs`（`piDepsLockHeld` ~19–40、`assertPiDependencyVersions` ~82）、`host/src/pi-update.js`（`acquireDepsLock` ~72–79） | 依存ロックの生存判定は `kill(pid, 0)` が ESRCH のときだけ放棄。Windows の EPERM や PID 再利用は生存扱いで `.leafcode-pi-deps.lock` を消さない。残ると Pi 同期も Host 起動ゲートも「同期が未完了」で拒否し続ける。mtime による期限は無い。 |
| 低 **[一部修正 2026-10-04: stat は初回と 64 書き込みごとの再同期のみ。世代を .1/.2 の2段にして、回転中に開かれた古いファイルが即 unlink されないようにした。並行書き込みの握りつぶしは未対応]** | `host/src/log-file.js` (~36–52) | 追記前に毎回 `statSync`。世代は `.1` のみ。並行書き込みは握りつぶす。 |

---

## P5 — パフォーマンス / ホットパス（18）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 高 **[一部修正 2026-10-04: sidebar snapshot に loaded を追加し、初回取得成功前の空スナップショット（および取得失敗中）では Bot/Room タブを閉じない。loaded 取得後の実削除は従来どおり]** | `web/src/components/shell/TaskPanesContext.tsx`（~426–448）、`web/src/lib/bot-sidebar-store.ts`（~24–30, 59–60） | Bot/Room タブの整理がサイドバー取得前の空スナップショットで走る。開いている `/bots/...` を「一覧に無い」とみなして閉じ、URL 同期で別画面へ飛ばしうる。取得失敗時も空のままなので復活しない。 |
| 高〜中 **[一部修正 2026-10-04: TaskView は active=false のとき SSE を張らない（前面化で再接続）。BotView は未読管理・streaming 表示・Code request polling に隠れたタブの SSE が必要なのでガードしない]** | `BotView.tsx` (~623–796)、`TaskView.tsx` (~1201–1619, mount ~3031) | SSE に `active` ガード無し。裏ペインでも EventSource が残り、分割タブぶん接続増。 |
| 中 **[一部修正 2026-10-04: SSE effectをactive falseでは実行せず、前面化で再接続]** | `web/src/components/bot/RoomView.tsx`（`active` ~143、SSE effect ~274–332） | Room の EventSource は `active` を見ず、依存が `[id]` だけ。裏の Room ペインでも接続と再接続が残る。Bot/Task の SSE ガード無しとは別画面。 |
| 中 **[一部緩和 2026-10-04: 走査エントリ上限 20000 を追加。走査結果をディレクトリ mtime + 5秒 TTL でメモ化し、連続GETの同期走査を省略。許可ルート検査は、ルート外のモデル置き場を壊すため未対応]** | `web/src/app/api/llama-server/models/route.ts`（GET ~110–146、`collect` ~76–108） | `dir` は browse 許可ルートを見ず、危険文字が無ければ任意の絶対パスを `readdirSync` で深さ 2 まで同期走査する。`statSync` はディレクトリの symlink を追跡する。遅い共有や巨大ツリーで BFF がブロックし、ワークスペース外の `.gguf` 名も返る。 |
| 中 **[一部修正 2026-10-04: web 側 tts-synthesize に 60s タイムアウトと 64MB 上限。CLI 側（leafcode-tts）の再生済み一時 wav を必ず削除（自分の process id 接頭辞のみ）。合成の先行並列起動は未対応]** | `web/src/app/api/tts/synthesize/route.ts`（~34–37）、`web/src/lib/tts-synthesize.ts`（~56–72, 82–90）、`extensions/leafcode-tts/index.ts`（~237–242, 266–281） | 合成 fetch にタイムアウトも応答サイズ上限も無い（話者一覧だけ 2.5 秒）。ハングしたエンジンが BFF を掴む。CLI 側はチャンクごとに合成を先に並列起動し、全文 wav を `os.tmpdir()` の `leafcode-tts-<pid>-<n>.wav` へ書く。再生失敗時は削除されない。 |
| 中 **[一部修正 2026-10-04: content-length 未宣言（chunked）の本文を上限つきで自前に読み、上限超過で formData() を呼ばず 413。export との同時保持（ロールバック用 archive）は未対応]** | `web/src/app/api/profile/route.ts`（POST ~46–51）、`web/src/lib/profile.ts`（`MAX_ARCHIVE_BYTES` ~18, `importProfileWithBackup` ~444） | 256MB 上限の検査より前に `file.arrayBuffer()` で全体をメモリへ載せる。それより大きいアップロードで BFF が先に落ちる。取り込みは現行プロファイルの export も同時に抱える。 |
| 中 **[一部修正 2026-10-03: ドライブ列挙を 10 秒キャッシュ＋同時呼び出しの共有。Quick Access は従来どおり]** | `dirs/route.ts` (~94)、`browse-drives.ts` (~40–46) | browse GET ごとにドライブ列挙。Win は PowerShell（Quick Access のみ 10s キャッシュ）。 |
| 中 **[一部修正 2026-10-04: 空ループのビジーウェイトを Atomics.wait に置換しCPU消費を除去。同期APIのため最大250msのブロックは残る]** | `extensions/leafcode-goal-loop/index.ts` (~681–708) | 状態 rename が EPERM/EBUSY のとき空ループで最大 ~250ms ビジーウェイト。OneDrive 掴みと重なるとスケジューラ停止。 |
| 中 **[一部修正 2026-10-04: git を1回の rev-parse にまとめ、parent と workflow の cwd が同一なら再解決しない（最大6→1〜2 spawnSync）。同期 spawn 自体は残る]** | `extensions/leafcode-subagents/src/workflows/chat-progress.ts`（~28–54, 74–78） | `resolveWorkflowChatProgress` が parent/workflow それぞれで最大 3 回の同期 `git`（合計最大 6 `spawnSync`）。ワークフロー開始のたびにイベントループを止める。 |
| 中 **[一部修正 2026-10-04: requestsディレクトリをmtime+inoでメモ化し1秒以内の再pollはreaddirSyncを省略。ルート直下のreaddirSyncとstatSyncは残り、mtime粗いFSでも1秒上限で復帰]** | `native-supervisor-channel.ts`（~25, 328–351, 701–709） | `CHANNEL_POLL_MS`（最短 250ms）で全 channel `readdirSync`。 |
| 中 | `scripts/web-build-mirror.mjs` (~105–114) | size+mtime 一致でも毎回フルバイト比較。 |
| 中 **[一部修正 2026-10-04: remote poll の snapshot に updatedAt+メッセージ数+状態+streaming の署名を含め、変化が無ければ送信せず所有権 probe のみ実行。detail 取得（HTTP/offline detail）自体は残る]** | `web/src/app/api/tasks/[id]/events/route.ts`（~266–325） | ローカル runtime・別ワーカー所有時、2 秒ごとに task detail とメッセージ全ページを SSE。 |
| 中 **[一部修正 2026-10-04: プレビューの全読み上限を 512KB まで下げ、それより大きいファイルは 1MB の末尾窓を使い、窓に最終発言が無い場合だけ 4MB 窓へ広げる。sidebar は Bot ごとの outbox 列挙を 1 回にまとめる]** | `web/src/lib/direct-session.ts` (~387–411)、`bots/sidebar/route.ts` (~37)、`Sidebar.tsx` (~1706–1708) | mtime 変化で Bot ごとに最大 ~4MB 読込→`buildSessionContext`→末尾1件。ストリーム中 12s poll で重い。 |
| 中 **[一部緩和 2026-10-04: 上限を 128M→32M 文字へ縮小。判定を追記前（バッファ超過前）へ前倒しし、stdout+stderr の長さも別 counter で管理]** | `web/src/lib/git.ts`（`GIT_MAX_OUTPUT_CHARS` ~14, 87–95） | git stdout/stderr を拒否前に最大約 128MiB 文字までヒープへ連結。巨大 diff で BFF が先にメモリ圧迫される。 |
| 中 **[一部修正 2026-10-04: server root + preferredId ごとに in-flight load を1件に共有し、後続呼び出しは自分の load を始めず同じ結果を待つ。単一呼び出しの最大180秒待ち自体は残る]** | `web/src/lib/llama-server-load.ts`（~16, 69–87）、`web/src/app/api/llama-server/ensure-loaded/route.ts` | `POST /api/llama-server/ensure-loaded` がモデル load 待ちで最大約 180 秒ブロック。Next BFF ワーカーを長時間占有しうる。 |
| 中 **[一部修正 2026-10-04: outbox を inode+size+mtime でメモ化し、未変更レコードを poll ごとの readFileSync から除外（save は temp+rename で inode も変わるため再読込は確実）。readdirSync と statSync は残る]** | `web/src/lib/pi/bot-code-relay.ts`（`requests` ~292–297、`codeTasksForOrigin` ~687–689） | Room SSE 相当で 2 秒ごとにメンバー数ぶん outbox 全 JSON を `readdir` + `readFileSync`。リレー tick / idle reaper でも同様。 |
| 中 **[一部修正 2026-10-04: 実測で画像 data URL が snapshot の 99.9% を占めることを確認。投影ごとに作り直さず mime+base64 で data URL をメモ化（16件上限）して文字列の churn を抑止。画像の実データを落とす payload 削減は未対応]** | `web/src/lib/pi/messages.ts` (~183–195) | UI 射影が画像 base64 を data URL のまま保持。長い画像セッションの snapshot／SSE が肥大。 |
| 中 **[一部修正 2026-10-04: GPU 皆無の環境は2回空だったら30秒間スキップ。CPU 温度も独立したTTL（既定30秒、LEAFCODE_SYSMON_TEMPERATURE_CACHE_MS で上書き可）と single-flight でキャッシュし、Add-Type 付き PowerShell の再起動を削減。失敗（null）は pin しない]** | `web/src/lib/sysmon-usage.ts` (~141–147, 625–628) | GPU 空なら `nvidia-smi` と PowerShell を即再起動。CPU 温度はキャッシュミス（~3s）ごとに `Add-Type` 付き PowerShell。 |

---

## P6 — リソースリーク / プロセス寿命（5）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 | `extensions/leafcode-memory/src/handlers/child-process-watchdog.mjs` (~12–15) | Linux で子を `detached`。watchdog SIGKILL だと孫が残る。 |
| 中 **[一部修正 2026-10-04: Windows でも taskkill /T /F で子ツリーを停止し、親PIDの消滅をポーリングして確認。mechanism=windows-taskkill-tree を追加（sidecar検証も対応）。taskkill 不在環境と孫の捕捉漏れは残る]** | `extensions/leafcode-subagents/src/runs/background/owned-process-tree.ts`（~70–78） | Windows はプロセスグループ非対応で単一 PID に SIGTERM 相当のみし、`unknown/unsupported-platform` を返す。子プロセスが孤児になりうる（Linux の detached 孫問題とは別経路）。 |
| 中 **[一部修正 2026-10-04: stop() が installProc を停止（Windows は taskkill /T で pip 子プロセスも含む）し、installState を error へ更新。install 自体のタイムアウトは未対応]** | `host/src/translation-service.js`（stop ~445–459, install ~755–785）、`index.js` (~1143) | 翻訳 install の `installProc` が stop／host 終了で kill されない。タイムアウトなし。 |
| 中 **[一部修正 2026-10-04: tool_execution_end ごとに toolStartedAt/toolEndedAt を512件上限で古い順に削除（最新分は保持）。throughputByStartedAt と partial output の長期蓄積は未対応]** | `web/src/lib/pi/harness.ts`（~1334, 1381–1418） | `throughputByStartedAt` / `toolStartedAt` / `toolEndedAt` に delete 無し。partial output 全文保持。長いセッション／abort でリーク。 |
| 中 **[見送り 2026-10-03: 「最新の読み上げを優先して直前を止める」意図的な単一再生。並行再生は音声が重なるため]** | `web/src/lib/tts-playback.ts` (~82–152) | プロセス全体シングル。分割表示で片方の読み上げがもう片方を abort。 |

---

## P7 — ファイル閲覧 / 添付（2）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 **[修正済 2026-10-03: mtime を lstat に変更し symlink を追跡しない]** | `web/src/app/api/diff/files/route.ts`（~187–192） | untracked の読み取りは symlink を避けているが、mtime 付与は全ファイルで `statSync`（リンク追跡）。ワークツリー内の symlink が外部やパイプを指すと、mtime が外へ漏れ、同期 stat が BFF をブロックしうる。コメントの「lexical isUnder でワークスペース内」は追跡後の実体を見ていない。 |
| 低 **[一部修正 2026-10-04: symlink/junction を stat で辿りディレクトリとして列挙。リンクループや到達不能リンクの扱いは従来どおり]** | `dirs/route.ts` (~108–111) | symlink／junction ディレクトリを落とすので配下が見えない。 |

---

## P8 — UI / UX（5）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 **[一部修正 2026-10-04: 開いている Bot タブ ID をストアに公開し、分割ペインの背景ペインにある Bot でもインライン抑止が効く]** | `web/src/components/BotRoutineNotifier.tsx`（~22–28）、`web/src/lib/notify.ts`（`isRoutineRunHandledInline` ~71–76） | ミュート判定がサイドバーのスナップショット依存。一覧が空（取得前や失敗）だと Bot が見つからず、`notificationsEnabled: false` でも完了音とデスクトップ通知を出す。インライン抑止は pathname が `/bots/<id>` のときだけで、分割ペインで Bot を開いていても二重に鳴りうる。 |
| 低 **[一部修正 2026-10-04: 先頭プレフィクス候補のクエリを64文字で打ち切り、長い本文で全候補を走査しない。参照トークンの全候補走査とデバウンス無しは未対応]** | `Composer.tsx` (~324–338)、`composer-references.ts` (~70–82) | キャレット末尾だと本文全体がクエリ。デバウンス無しで全候補走査。 |
| 低 **[修正済 2026-10-03: light→dark→oyster→system を循環]** | `web/src/app/layout.tsx`（~36）、`web/src/components/ui.tsx`（~577–587） | `themes` に `oyster` と `system` があるのに、切替は `resolvedTheme === "dark"` だけ。oyster / system からは常に light か dark の固定値になり、元の指定へ戻れない。 |
| 低 **[修正済 2026-10-03: アンマウント時に未保存レイアウトを flush]** | `web/src/components/shell/TaskPanesContext.tsx`（~505–517） | ペイン保存は 500ms デバウンス。アンマウント時にタイマーを消すだけで書き出さないので、分割直後に離れるとレイアウトが残らない。 |
| 低 **[修正済 2026-10-03: 深さ6上限と一部ディレクトリ除外。symlink は Dirent で非追跡]** | `web/src/lib/agents.ts`（`discoverInDir` ~209–216） | エージェント `.md` 探索が深さ・サイクル制限なしの再帰。深い木やジャンクションで一覧が重く／スタックしうる。 |

---

## P9 — その他（3）

| 重大度 | 箇所 | 内容 |
| --- | --- | --- |
| 中 **[一部修正 2026-10-04: issue 時の2回目の readState（参加者判定用）を廃止し同一 state を再利用。claim 経路でも prune を実行し、発行のない Room の期限切れ envelope・孤立 claims も掃除。整形書き込み（JSON indent）は未対応]** | `backend/core/room-relay.mjs` (~67–94)、`room-store.mjs` (~77–96) | consumed envelope / claims が TTL 後も残る。claim ごとに全件 parse＋整形書き込みで単調増加。 |
| 中 **[一部修正 2026-10-04: owner の pending map が変化した時だけ await 後の room 再読込を行う。無変化の idle Room は 2 秒ごとに disk を読まない]** | `web/src/app/api/bots/rooms/[id]/events/route.ts` (~137–170) | Backend 所有時、Room を開いている間 2 秒間隔で room 再読込＋pending HTTP。 |
| 低 **[一部修正 2026-10-04: read-only ハンドルを mtime+size+ino のスタンプ付きでキャッシュし、検索ごとの DB 再オープンを解消（60秒 idle・4ファイルで破棄、ファイル変更時は作り直し）。OR の再現率と LIKE 全表スキャンは仕様どおり未対応]** | `web/src/lib/memory-search.ts` (~38–47) | 複数語は AND ではなく `LIKE` OR。そのたびに DB 再オープン＋全表スキャン。 |
