# Pi MCP / codemode 監査（2026-10-04）

読み取り専用。製品ソースは未変更。対象は Pi 1.0.0 系の native MCP・codemode・tool_search / deferred・loadout 周辺のみ。

## メタ

| 項目 | 値 |
|---|---|
| 日時 (Asia/Tokyo) | 2026-10-04 |
| マシン | X870 |
| リポジトリ | `C:/Users/Daichi/Desktop/LeafCodePi` |
| HEAD | `11a2daf1`（第5巡時点。第4巡と同 HEAD。MCP/codemode 本体知見は `df4d6dc8` 以降。第3巡 `c0e50d25` / dispatch `e13efb2d`） |
| 焦点 | MCP native/session、tool_search/deferred、codemode、harness loadout/active tools、関連 auth/config |
| 旧監査 | `BUGS-PERF-AUDIT-2026-10-03.md` は編集していない（参照のみ） |

## Pi バージョン文字列

| パッケージ | package.json / インストール |
|---|---|
| `@earendil-works/pi-coding-agent` | `1.0.0`（web / backend） |
| `@earendil-works/pi-ai` | `1.0.0` |
| `@earendil-works/pi-mcp` | `1.0.0`（coding-agent 依存） |
| `@earendil-works/pi-codemode` | `1.0.0`（coding-agent 依存） |

関連コミット例: `940ba93f` adapter 撤去、`0588b527` excludeTools、`68e0ab5c` tool_search 一本化、`c6ec1f23`/`2ea7aff3` codemode E2E、`1a153ec5` setActiveToolsByName フォローアップ。

## 件数（重大度）

| 重大度 | 件数 | 内訳メモ |
|---|---:|---|
| 高 | 7 | 第1–4巡6 + 第5巡: OAuth discovery/AS の SSRF（私設 https） |
| 中 | 19 | 第1–4巡15 + 第5巡: annotations 未使用、instructions 非上限、image 非上限、roots パス開示 |
| 低 | 14 | 第1–4巡11 + 第5巡: list_changed 競合、Windows temp mode、Session-Id 非境界 |
| 既存同根（簡潔） | 3 | async factory await / keyword hijack / loadout×session_start（修正済・確認済） |
| **新規扱い合計** | **40** | 第1–4巡32 + 第5巡8（既存同根を除く） |
| 第2巡のみ | 高1 / 中4 / 低3 | 下記 §6 |
| 第3巡のみ | 高1 / 中4 / 低3 | 下記 §7 |
| 第4巡のみ | 高1 / 中4 / 低3 | 下記 §8 |
| 第5巡のみ | 高1 / 中4 / 低3 | 下記 §9 |

---

## 1. MCP native / session

### 1.1 [高] native 有効だが prepare 失敗時、standalone codemode にも落ちない

| 項目 | 内容 |
|---|---|
| 重大度 | 高 |
| 場所 | `backend/core/mcp-native-session.mjs`（`nativeMcpExtensionFactory` ~29–41）、`web/src/lib/pi/harness.ts`（~4023–4026）、方針 `docs/plans/codemode-effect.md` |
| 再現イメージ | `LEAFCODE_PI_MCP_NATIVE` opt-in 後、provider が `{ ok:false }` / throw / factories 空を返す |
| 挙動 | `active: true` かつ `factories: []`。standaloneCodemode は **呼ばれない**（テストも「must not fall back」で固定）。MCP も codemode も無いセッションになる |
| なぜ新規か | `df4d6dc8` で Code 常時 codemode と standalone フォールバックを入れたが、コメント／テストどおり **active だが失敗した provider にはフォールバックしない**。方針と fail-closed が衝突。旧監査の async await 修正とは別軸 |
| 修正方針 | active だが factories 空のときだけ `createCodemodeExtension({ mode:'on', models:false })` を残す。MCP は fail-closed のまま |

### 1.2 [中] 同上で `dynamicMcpTools` が true のまま excludeTools 経路に入る

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `harness.ts` `createSession` ~3983–4088（`nativeMcp.active && !agentTools && !botTools`） |
| 挙動 | factories が空でも `active` だけで excludeTools + `initialActive` を選ぶ。実 MCP は来ないのに「動的 MCP 用」構成になる |
| 修正方針 | `nativeMcp.active && nativeMcp.factories.length > 0`（または issues 空）で dynamic 判定 |

### 1.3 [高] HTTP MCP URL が https 私設・リンクローカルを拒否しない（SSRF ギャップ）

| 項目 | 内容 |
|---|---|
| 重大度 | 高 |
| 場所 | `backend/core/mcp-native-http-transport.mjs` ~84–86、コメント ~27「not SSRF/DNS pinning」。`mcp-config-validation.mjs` にも私設 IP 検査なし |
| 挙動 | 許可は「https **または** loopback の http」。`https://169.254.169.254/...` や `https://192.168.x.x`、メタデータ DNS 名は通る。`redirect:'error'` のみ。owner `fetch` は既定 `globalThis.fetch` |
| 前提 | mcp.json を書ける主体（UI/ACL 通過後）が必要。信頼境界内でもクラウドメタデータ等への横移動になり得る |
| 修正方針 | 解決後 IP の私設/リンクローカル/メタデータ拒否、または allowlist。OAuth `context.fetch` も同ポリシー |

### 1.4 [中] `!command` シークレット解決が `shell: true`

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `backend/src/mcp-native-activation.mjs` `runEnvCommand` ~15–22、`mcp-native-env-commands.mjs` |
| 挙動 | ヘッダ/env の `!cmd` を `spawnSync(..., { shell: true, timeout: 10s })` で実行。設定書込 ACL 前提の互換経路だが、設定改ざん＝Backend ユーザ権限でのコマンド実行 |
| 修正方針 | shell 無し・固定バイナリ allowlist、または `!` 廃止して秘密は credential store のみ |

---

## 2. tool_search / deferred

### 2.1 [低] exact 一致時は SDK MCP 検索を走らせない

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | `web/src/lib/pi/deferred-tools.ts` ~80–90, ~98（`exact` 分岐） |
| 挙動 | query が deferred 名と完全一致（例 `bash`）だと native `tool_search` に委譲しない。同名関心の MCP ツールは見つからない |
| 修正方針 | exact でも native を併走するか、`mcp:` / `mcp__` プレフィクス時は必ず SDK 側 |

### 2.2 既存監査と同根（簡潔）

| 項目 | 内容 |
|---|---|
| 旧: keyword hijack | `search`/`web` 等で MCP 委譲しない → **修正済**（非 exact 時 SDK 併走 ~95–106） |
| 旧: async factory 未 await | `nativeMcpExtensionFactory` → **修正済**（pending.then 連鎖 ~33–41） |

---

## 3. codemode

### 3.1 方針と実装の要点

- 通常 Code: `createCodemodeExtension({ mode: 'on', models: false })` を常時（native 無しは standalone、native 有りは `nativeFactories` 内の 1 本）。
- SDK 上 codemode / tool_search は `defaultActive: false`。harness が `sessionToolNames` に含め `setActiveToolsByName(initialActive)` で宣言する。
- Bot・エージェント厳格 allowlist には暗黙追加しない（テストで固定）。

### 3.2 [高] と 1.1 の関係

native 失敗時は 1.1 により **codemode 自体がレジストリに載らない**。`setActiveToolsByName(['codemode', ...])` しても未登録名は無視される。

---

## 4. harness loadout / active tools

### 4.1 excludeTools 経路（正常系）

`session-tool-selection.ts`: native かつ非 Agent/Bot のとき `excludeTools` + `initialActive`。`NATIVE_MCP_TOOL_NAMES = ['codemode']`。後から繋がる `mcp__*` を allowlist で潰さないため。

### 4.2 既存監査と同根（簡潔）

| 項目 | 内容 |
|---|---|
| 旧: session_start 後の loadout 上書き懸念 | `setActiveToolsByName` は `bindExtensions`（session_start）**より前**（~4115 → ~3791）。**確認済・現状該当せず** |
| deferred `session_start` | 現行は active をフィルタ＋`tool_search` 追加で、許可された deferred を落とさない |

### 4.3 [中] `applySubagentPermission('deny')` が pending MCP を消し得る

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `harness.ts` ~10120–10137、SDK `AgentSession.setActiveToolsByName`（ツールを **外す** と `_pendingToolNames.clear()`） |
| 挙動 | 接続中の MCP を pending に載せた直後に subagent を deny すると、pending 全体が落ち、遅延登録ツールが自動活性化されない |
| 修正方針 | subagent だけを差し引く API、または pending を保存して戻す |

### 4.4 reload

`reloadSession` は `session.reload()` のみで、作成時の `setActiveToolsByName(initialActive)` は再実行しない。SDK が active を pending 化して session_start 再発火。回帰は `b437e10f` 系。fail 時の 1.1 とは別。

---

## 5. 関連 auth / config / サブエージェント

### 5.1 [高] サブエージェント MCP direct allowlist が旧命名・旧キャッシュ前提

| 項目 | 内容 |
|---|---|
| 重大度 | 高 |
| 場所 | `extensions/leafcode-subagents/src/runs/shared/mcp-direct-tool-allowlist.ts`、`pi-args.ts` ~513–550 |
| 挙動 | `mcp-cache.json` と従来 `server_tool` 形式。native の実行名は `mcp__<server>__<tool>`。キャッシュ無し／不一致だと unresolved のまま厳密失敗、または誤名を `--tools` に載せる |
| テスト | `pi-args.test.ts` は「mcp-cache 無し」ケース中心で `mcp__` 変換を見ていない |
| 修正方針 | native 名へ正規化、または子セッションを LCP native provider と同じ経路に揃える。キャッシュ世代を native 接続結果と同期 |

### 5.2 [低] Agent/Bot の `tools` 厳格 allowlist では MCP が `_isAllowedTool` で落ちる

| 項目 | 内容 |
|---|---|
| 重大度 | 低（設計制約） |
| 場所 | SDK `_isAllowedTool`、`harness` `dynamicMcpTools = ... && !agentTools && !botTools` |
| 挙動 | 後登録の `mcp__*` は allowlist 外ならレジストリに入れない。ドキュメント上も暗黙付与しない |
| 注 | Bot の `botActiveToolNames` は非 Bot 名を preserve するが、そもそも登録されないと無意味 |

### 5.3 auth メモ（今回の新規不具合としては弱）

- native auth 書込は owner 経路。legacy adapter 書込は 409 拒否（`legacyAuthWriteRefusal`）。
- OAuth remove は in-flight refresh をキャンセルしない（コードコメント上の既知制限）。
- credential `withRefreshLock` あり（旧監査の CodexBar refresh 競合とは別系統）。

---

## MCP / codemode 修正優先度（この文書の範囲のみ）

1. **P0** — native 失敗時も Code に codemode を残す（1.1）＋ dynamicMcp 判定を factories 実在に合わせる（1.2）
2. **P0** — HTTP MCP の私設/メタデータ宛先拒否（1.3）＋ OAuth discovery/AS fetch の同ポリシー（9.1）
3. **P0** — reload 中の MCP `createConnection` 孤児 close（6.1）／prepare・install の live binding retire（7.1）／tool_search による codemode MCP 宣言昇格（8.1）
4. **P1** — サブエージェント MCP direct を native 命名に追従（5.1）／stdio env 漏洩（6.4）／progress×timeout（7.2）／cwd 脱出（7.3）／resource widest（8.2）／read URI（8.3）／Host ヘッダ（8.4）／annotations（9.2）／image 上限（9.4）
5. **P2** — `!command` shell（1.4）、subagent deny×pending（4.3）、startup 待ち（6.2）、ask×MCP（6.3）、env 固定（6.5）、SessionExpired detach（7.4）、Bot `mcp` 残骸（7.5）、revision drift retire（8.5）、instructions 上限（9.3）、roots 開示（9.5）
6. **P3** — exact tool_search（2.1）、Agent/Bot MCP UX（5.2）、薄い schema（6.6）、settings 上書き（6.7）、HTTP tool 非リトライ明記（6.8）、hidden×owners（7.6）、progress 非上限（7.7）、Windows 孤児（7.8）、mcp.log（8.6）、OAuth callback host（8.7）、codemode 巨大結果（8.8）、list_changed 競合（9.6）、temp mode（9.7）、Session-Id（9.8）

---



---

## 6. 第2巡（深掘り・2026-10-04 追記）

対象 HEAD は引き続き `df4d6dc8`。第1巡掲載項目は再掲しない。`pi-codemode` 1.0.0、`pi-mcp` 1.0.0、`pi-coding-agent` MCP extension / runtime、permission-gate、stdio transport、activation env を追加精読。

### 6.1 [高] reload / `session_shutdown` と `createConnection` の競合で接続が close されない

| 項目 | 内容 |
|---|---|
| 重大度 | 高 |
| 場所 | SDK `createMcpExtension`（`startConnection` / `createConnection` / `session_shutdown`）、bundle chunk |
| 挙動 | `startConnection` は `await loadMcpRuntime` 後に `isCurrent()` を見てから `createConnection`。`createConnection` は完了時に `server.connection=connection` を代入する。その直後に `session_shutdown` が `generation++` と `servers=[]` で既知接続だけ `close()` すると、**代入済みだがもう `servers` に載っていない connection** が残る（`isCurrent()` 偽で `getClient` はスキップ）。stdio 子プロセスが孤児化しやすい |
| 再現イメージ | MCP 接続中に `session.reload()` / AGENTS・設定の deferred reload |
| 修正方針 | `createConnection` 前後で `isCurrent` 再検査し、偽なら即 `connection.close()`。または shutdown 時に in-flight を追跡して drain |

### 6.2 [中] `waitForDirectServers` が default exposure（codemode）を待たない

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | SDK MCP extension `waitForDirectServers`（`hasDirectTools` のみ）、`getMcpToolExposure` 既定 `exposure ?? "codemode"` |
| 挙動 | LCP / Pi 既定の MCP ツールは model に direct 宣言されず codemode/deferred。`before_agent_start` の待機は **direct サーバだけ**。初回 prompt 時点でサーバ未接続でもターンが進み、`tool_search` / codemode 内呼び出しが空振りし得る |
| 修正方針 | deferred/codemode 到達のサーバも短時間待つ、または「未接続」を system 節に明示してモデルに再試行させる |

### 6.3 [中] permission mode `ask` が一般 MCP ツールを承認 UI に載せない

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `extensions/leafcode-permission-gate/index.ts` `tool_call`（~1442–1600） |
| 挙動 | `ask` の危険コマンドダイアログは **bash/powershell**（と computer-use）中心。`mcp__*` は system-safety マッチ時のみ `requireSystemApproval`。マッチしなければ `allow` 相当で通過。codemode は ToDo ゲートで容器免除だが、内部呼び出しは個別 `tool_call` → 同様に MCP は ask 対象外になりやすい |
| 修正方針 | `ask` 時は MCP / codemode ネストも要約付き承認、または server/tool 単位のポリシー |

### 6.4 [中] stdio MCP に Backend の `process.env` 文字列全体が渡る

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `mcp-native-activation.mjs`（`environment: { ...process.env }` スナップショット）、`mcp-native-stdio-transport.mjs`（`inheritEnv: false` だが explicit `env` にフルマップ）、`pi-mcp` StdioTransport |
| 挙動 | 子は ambient inherit しないが、**起動時 env の全文字列値**を受け取る。API キー等が全 stdio MCP に見える。`records()` は文字列以外を落とすだけ |
| 修正方針 | allowlist（PATH/HOME/LANG 等）＋サーバ `env` / credential のみ。秘密は credential store |

### 6.5 [中] env / variables スナップショットが activation 構築時に固定

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `createNativeMcpActivation` コメントと実装（environment/variables を construction で capture） |
| 挙動 | Backend 起動後に入れた環境変数・`${NAME}` 展開元は、`install`/再起動まで MCP に反映されない。stdio/HTTP 双方 |
| 修正方針 | `install`/`runConfigWrite` 時に再スナップショット、または参照時解決 |

### 6.6 [低] MCP `inputSchema` → ツール parameters 変換が薄い

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | SDK `toParameters`（`type`/`properties` 補完のみ）、`createMcpToolDefinition` |
| 挙動 | `isObject(inputSchema)` なら登録。`$ref` 壊れ・過剰 `additionalProperties` などもほぼ素通し。実行時の引数検証が弱い |
| 修正方針 | JSON Schema 検証を厳密化、または不正 schema のサーバ/ツールを拒否 |

### 6.7 [低] df4d6dc8: Pi Settings の `codemode.mode` が harness 固定 `mode:"on"` で無効化

| 項目 | 内容 |
|---|---|
| 重大度 | 低（意図的エッジ） |
| 場所 | `harness.ts` `createCodemodeExtension({ mode: "on", models: false })`、`codemode-default-sdk.test.ts`（Settings `mode:"only"` でも direct 併存を検証） |
| 挙動 | ユーザー/エージェントが settings で codemode-only 等にしても LCP Code は `on` 固定。Bot には `BOT_TOOL_NAMES` に **codemode 無し**（`tool_search` はある）。Room 委譲の Code タスクは codemode 有、Bot 本人セッションは無 |
| 修正方針 | ドキュメント明記、または Settings を尊重するオプトイン |

### 6.8 [低] HTTP MCP の tool call は一時障害でリトライしない

| 項目 | 内容 |
|---|---|
| 重大度 | 低（SDK 仕様） |
| 場所 | `pi-coding-agent` `extensions/mcp/runtime.js` `withClient` |
| 挙動 | readOnly は transient HTTP を1回リトライ。**tool call はリトライしない**（副作用考慮）。`McpSessionExpiredError` は「未実行」前提で1回だけ新セッション。LCP の AbortSignal は `callTool({signal,timeoutMs})` 経由で効く（デフォルト timeout はサーバ `timeout` 秒、未設定時 60s） |
| 修正方針 | UI/通知で「一時失敗は手動再実行」、idempotent ツールだけリトライ許可リスト |

### 第2巡で確認して問題にしなかった点（簡潔）

- `config.timeout`（秒）→ `timeoutMs` は SDK で接続されている（未設定 60s）。
- stdio の argv 配列渡しで Windows スペースは概ね安全。LCP は絶対パス `.exe/.com` のみ（`.cmd` 拒否）。
- codemode QuickJS worker: ネスト tool に AbortController、親 abort で pending を abort。デフォルト実行 timeout 300s（`@options timeout_ms` 可）。`fetch`/`process` 無し。
- MCP `onProgress` → tool `onUpdate` のストリーミング経路は存在。
- `mcpNamespace` の `foo-bar` / `foo_bar` 衝突は SDK/LCP transport 双方で拒否。
- Bot の `tool_search` 有・`codemode` 無は df4d6dc8 方針どおり（ただし native MCP ツールは第1巡 5.2 のとおり allowlist で非到達）。




---

## 7. 第3巡（深掘り・2026-10-04 追記）

対象 HEAD `c0e50d25`（`default` 全登録ツール動的継承）。第1–2巡掲載項目は再掲しない。焦点: reconnect、ツール名衝突、ストリーミング結果、Bot/Task/Room 差分、stdio cwd/quoting（Windows）、MCP cancel/timeout 競合、prepare vs session_start、Code default-codemode の未掲載エッジ。

### 7.1 [高] `prepare`/`install` が稼働中セッションの binding を retire し、失敗時は「公開済みだが死んだ」provider が残る

| 項目 | 内容 |
|---|---|
| 重大度 | 高 |
| 場所 | `mcp-native-config-owner.mjs`（`prepare` 冒頭の `retire()` → `sequence++`）、`mcp-native-runtime.mjs`（`install` / `writeAuth` → `prepareRuntime`）、stdio/HTTP transport の `assertSnapshotOwner` |
| 挙動 | 新しい `prepare()` は受理時に **先行 binding を必ず invalidate**。stdio/HTTP は送受信ごとに owner を検査し、偽なら `stopDelivery`（即 close）。`writeAuth` コメントの「running sessions keep their snapshot」はデータ保持の話で、**権限は切れ MCP 呼び出しは fail-closed**。さらに `install` コメントどおり、reload 失敗時は **旧 provider 関数が残ったまま retired binding** → 既存も新規も MCP 全滅まで成功 install 待ち |
| 再現イメージ | Code セッションで MCP 実行中に設定保存 / auth 書込 / `install()`。または prepare 途中失敗 |
| 第6.1との差 | 6.1 は SDK `createConnection` 孤児。本項は LCP owner generation が **生きている接続を能動的に殺す**／失敗時に死んだ provider を公開し続ける |
| 修正方針 | 稼働中セッション用 binding を generation 分離して drain 後に retire。失敗時は旧 ticket を復元するか provider を unset。UI は再 bind / session reload を明示 |

### 7.2 [中] MCP `notifications/progress` がリクエスト timeout を都度リセットし、実質無制限化できる

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `pi-mcp` `client.js` `handleProgress` → `armTimeout`；ツール側 `onProgress` → `onUpdate`（`extensions/mcp/tools.js`） |
| 挙動 | `config.timeout`（既定 60s）は progress のたびに振り直し。サーバが細かい progress を送り続ければ **壁時計 timeout は発火しない**。ユーザー AbortSignal は別経路で有効。cancel 後に遅延 response が来ると `unknown MCP request` を emitError（二重 resolve はしない） |
| 修正方針 | 絶対 deadline（start+timeoutMs）と idle timeout を分離。progress は idle のみ延長。異常 progress レートを制限 |

### 7.3 [中] stdio `config.cwd` が `sessionCwd` 配下に閉じ込められない（パス脱出）

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `mcp-native-stdio-transport.mjs` `childCwd = resolve(sessionCwd, expandHome(config.cwd ?? "."))` |
| 挙動 | 工場引数の `cwd` は sessionCwd 一致必須だが、**スナップショット内 `config.cwd`** は `..` や絶対 `~/...` 展開でプロジェクト外へ出られる。Windows でも `resolve` どおり。コマンド自体は絶対 `.exe/.com`＋argv 配列（quoting は概ね安全・第2巡確認）だが、子の相対ファイル I/O 基点が外にずれる |
| 前提 | mcp.json 書込 ACL と同信頼境界（1.3/1.4 と同型） |
| 修正方針 | `childCwd` を sessionCwd 配下に正規化・拒否。絶対 cwd は allowlist |

### 7.4 [中] `McpSessionExpiredError` 時に旧 client を detach したまま close しない

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `extensions/mcp/runtime.js` `withClient`（SessionExpired で `this.client = undefined`、コメントどおり旧 client は意図的に非 close） |
| 挙動 | 並列 in-flight を壊さないための設計。一方、他に in-flight が無い／サーバが本当に死んだ場合は **detach された HTTP セッションやバッファが回収されない**。tool call 自体は SessionExpired のみ1回リトライ（一時 HTTP は readOnly のみ・6.8）。手動 `reconnect()` は現行 client だけ `dropClient` |
| 修正方針 | 参照カウント／idle 後 close。または SessionExpired 時に in-flight ゼロなら即 close |

### 7.5 [中] Bot / Room-Bot は allowlist に旧名 `mcp` があり、`codemode` が無く、native では MCP 非到達

| 項目 | 内容 |
|---|---|
| 重大度 | 中（設計ギャップ＋残骸） |
| 場所 | `shared/bot-tools.mjs` `BOT_TOOL_NAMES`（`tool_search`・**`mcp`**・**codemode 無し**）、`harness` `dynamicMcpTools = ... && !botTools`、`resolveBotSessionOptions`（Room origin でも `botTools`） |
| 挙動 | native 有効時は adapter 除外で **`mcp` ツールは登録されない**。`mcp__*` は Bot 厳格 allowlist で拒否（5.2）。Room 起点 Bot も同じ。Room→Code 委譲（`createBotCodeTask`）だけ Code loadout＋codemode/MCP。Bot 設定上「mcp」が残るのに実行経路が空 |
| 修正方針 | `mcp` をリストから外すか native 名へ。Bot に MCP を許すなら `codemode`/`dynamicMcp` 方針を文書化して実装。Room と Code 委譲の差を UI に明示 |

### 7.6 [低] サーバが下げたツールは `exposure:"hidden"` 再登録＋`toolOwners` がセッション中ピン留め

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | SDK MCP extension `registerTools` / `hideTools`（`toolOwners` Map、`definitions` Map） |
| 挙動 | unregister 不可のため withdrawn は hidden（呼び出し不可は `_getCallableTools` で確認）。一方 **owner 名は Map から消えない**ため、別サーバ／別名の sanitize 衝突時はハッシュサフィックスが残りやすい。再登場時は同一 owner なら平文名復帰 |
| 修正方針 | hide 時に owner を解放、または世代付き owner |

### 7.7 [低] ストリーミング progress は 20KB 制限外、最終結果だけ `limitMcpContent`

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | `extensions/mcp/tools.js` `execute` の `onProgress` → `onUpdate`（生テキスト）、`convertMcpResult` → `limitMcpContent`（20KB＋一時ファイル） |
| 挙動 | モデル／UI は途中で巨大 progress を見うる。最終は中間切り＋ fullOutputPath。codemode スクリプト向け `structuredContent` は非切り詰め（意図どおり） |
| 修正方針 | progress にもバイト上限、または最終と同じ truncate 方針 |

### 7.8 [低] Windows stdio は process group 無し；異常終了時の子プロセス孤児化

| 項目 | 内容 |
|---|---|
| 重大度 | 低（平台） |
| 場所 | `pi-mcp` `transports/stdio.js`（`USE_PROCESS_GROUPS = platform !== "win32"`、close 時のみ `taskkill /T /F`） |
| 挙動 | argv 配列＋LCP の絶対 `.exe/.com` 制限で quoting 問題は小さい。ただし Backend が close せず落ちると **Windows では process group 追跡も exit hook も無い**ため MCP 子が残りやすい（6.1 孤児と相乗） |
| 修正方針 | job object／明示的 pid 台帳。crash 時の再起動で残骸掃除 |

### 第3巡で確認して問題にしなかった点（簡潔）

- `cancelPending` は pending 削除後 no-op → abort×timeout の二重 reject なし。
- tool `getClient: async () => connection` は長寿命 Connection ラッパ；`reconnect()` 後も同一ラッパ経由で `withClient`。
- `createMcpToolName` の衝突は plain 重複時ハッシュ。ハッシュ結果の再 `isTaken` は無いが owner キーが `server\0tool` で実質一意。
- `toToolExposure("codemode") → "deferred"` は description 除外用。discovery 活性化は config 側 exposure で分岐（意図どおり）。
- `c0e50d25`: `default` は `allTools`（exclude 空＋後登録 MCP 到達）。named Agent / Bot の厳格 allowlistは維持。default-codemode の「default に載らない」問題は本 commit で意図的に解消済み → 新規不具合にはしない。
- Room 委譲 Code が MCP を持つ非対称は 6.7/7.5 に集約。

### 第3巡スキャン追加パス
- `pi-mcp` client timeout/progress/cancel、`transports/stdio.js`
- SDK `extensions/mcp/{tools,runtime,index}.js`（reconnect / toolOwners / hidden / SessionExpired）
- `mcp-native-{config-owner,runtime,stdio,http,session,extensions}.mjs`、`mcp-native-activation.mjs`
- `shared/bot-tools.mjs`、`bot-session-options.mjs`、`session-tool-selection.ts`（`c0e50d25` 後）
- `docs/plans/codemode-effect.md`（default 動的継承追記）



---

## 8. 第4巡（深掘り・2026-10-04 追記）

対象 HEAD `11a2daf1`。第1–3巡掲載（新規24＋既存同根3）は再掲しない。焦点: resources、OAuth/callback、HTTP headers、tool_search×exposure、revision verify、mcp.log、codemode 結果サイズ。

### 8.1 [高] `tool_search` が MCP 既定 `exposure:"codemode"` 相当をモデル宣言へ昇格できる

| 項目 | 内容 |
|---|---|
| 重大度 | 高 |
| 場所 | SDK `extensions/mcp/tools.js` `toToolExposure`（`"codemode"` → pi `"deferred"`）、`extensions/tool-search/tool.js` `isSearchable`（`"codemode"` または `"deferred"`）、LCP Code loadout（`codemode` と `tool_search` を常時 active） |
| 挙動 | ドキュメント／拡張ヘッダは既定 MCP を「モデル宣言に載せず codemode スクリプトからのみ」。だが (1) 登録時 exposure が `deferred` に潰され、(2) `tool_search` は両 exposure を検索して `setActiveTools` で **次ターンのモデル宣言に載せる**。LCP は両方の発見ツールを常時有効なため、モデルが `tool_search` するだけで `mcp__*` が direct 相当に昇格し、宣言肥大・結果の直接注入面が増える |
| 第2.1/6.2との差 | exact 検索欠落や startup 待ちではなく、**方針上 undeclared のはずのツールが discovery 経由で宣言される** |
| 修正方針 | `isSearchable` を config/`deferred` のみに限定、または MCP `codemode` を pi `"codemode"` のままにし tool_search 対象外。LCP は codemode 優先時に tool_search の MCP 昇格を抑止 |

### 8.2 [中] リソースツール（list/read_mcp_resource*）がサーバ横断で「最も広い exposure」に昇格

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | SDK MCP extension `syncResourceTools`（`["direct","codemode","deferred"].find`） |
| 挙動 | リソース付きサーバのうち1つでも `exposure:"direct"` なら、**全サーバ向け**の `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` が direct 登録される。codemode 専用のつもりだったサーバのリソースもモデルから直接列挙・読取可能 |
| 修正方針 | サーバ引数必須＋サーバごとの exposure、または常に最狭（hidden 以外の共通部分）／codemode 固定 |

### 8.3 [中] `read_mcp_resource` は URI を事前リストと照合しない

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `extensions/mcp/resources.js` `readResource` execute（`server`＋`uri` をそのまま `readResource`） |
| 挙動 | 説明文は list の URI を前提とするが、実装は **任意 URI** をサーバに渡す。filesystem 系 MCP では未一覧の `file://` 等を読める可能性（サーバ実装依存）。サーバ名の存在チェックのみ |
| 修正方針 | 直近 list 結果の allowlist、またはサーバ側 roots に閉じるゲートをホストで強制 |

### 8.4 [中] HTTP MCP `headers` に hop-by-hop / `Host` 禁止リストが無い

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `mcp-native-http-transport.mjs`（token 文法と重複名のみ検査→`new Headers`）、`pi-mcp` StreamableHttpTransport `headers()` |
| 挙動 | `Host` / `Connection` / `Transfer-Encoding` 等も設定できれば送出対象。逆プロキシや仮想ホスト取り違え、リクエスト線と Host 不一致などの余地。信頼境界は mcp.json 書込 ACL（1.3 と同型）だが SSRF ギャップと組み合わさると影響が増幅 |
| 修正方針 | fetch 禁止ヘッダ denylist（少なくとも `host`、`content-length`、`transfer-encoding`、`connection`） |

### 8.5 [中] ディスク上 `mcp.json` の revision 不一致で `assertOwner` が self-`retire` し稼働中 MCP が死ぬ

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `mcp-native-config-owner.mjs` `verify`→`checkRevision`、失敗時 `assertOwner` が `current === binding` なら `retire()`＋`lease.revoke()` |
| 挙動 | install/prepare（7.1）以外に、**外部編集・別プロセス書込・ハッシュ不一致**でも次の stdio/HTTP 送受信で binding 全体が invalidate。コメントの「running sessions keep snapshot」と実務挙動が食い違う点は 7.1 と同系だが、トリガが「成功した新 prepare」ではなく **revision drift** |
| 修正方針 | drift 時はセッションを read-only 警告＋再 bind 要求に留め、global `retire` しない。または世代をセッションに sticky |

### 8.6 [低] `mcp.log` はサーバ `notifications/message` をマスクせず追記し、ローテートは lock 無し

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | SDK `extensions/mcp/log.js`（`appendFileSync`、`MAX_LOG_BYTES` 超で `renameSync`→`.1`） |
| 挙動 | `data` を JSON 文字列化してそのまま書くため、サーバがトークン等を載せると agent-dir に残る。複数プロセスの size チェック＋ rename は TOCTOU（host ログ側の並行追記対策 `11a2daf1` とは別ファイル） |
| 修正方針 | 秘匿パターンのマスキング、advisory lock、またはサイズ追跡を host ログと同型に |

### 8.7 [低] OAuth `callbackUrl` 設定次第で listen host が loopback 以外になり得る

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | SDK `extensions/mcp/oauth.js` `callbackSettings`（`localhost` のみ 127.0.0.1 に正規化、他 hostname はそのまま listen） |
| 挙動 | 既定は 127.0.0.1。settings で `callbackUrl` に非 loopback を書くとコールバックサーバがそこへ bind し得る。LCP native は現状カスタム callback を渡していないが、SDK 面は開いている |
| 修正方針 | loopback 強制。LCP は callback オプションを常に固定 |

### 8.8 [低] codemode スクリプトは MCP `CallToolResult` を非切り詰めで受け取り、巨大 `structuredContent` で VM を圧迫し得る

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | `extensions/mcp/tools.js` ヘッダ（scripts は truncate しない）、`extensions/codemode/execute.js`（QuickJS heap 256MiB） |
| 挙動 | モデル向けは 20KB＋一時ファイル（7.7）だが、ネスト MCP のスクリプト戻りは全文。意図的だが、悪性／巨大リソースで 256MiB 上限までのメモリ圧。画像は別途 temp |
| 修正方針 | スクリプト向けにもソフト上限、または大きな blob はパス参照のみ |

### 第4巡で確認して問題にしなかった点（簡潔）

- OAuth refresh に proper-lockfile（stale 20s / wait 25s）あり。removeOAuth が in-flight refresh をキャンセルしない既知制限は第1巡メモのまま。
- リソースツールは MCP App（`ui://` / mcp-app profile）を list から除外。
- HTTP `redirect:'error'`、header 名の重複・制御文字拒否は維持（Host 禁止が欠ける点が新規）。
- stdio 並列 call は JSON-RPC id 多重化でプロトコル上は可。専用 mutex は無いが id で応答対応（新規不具合にはしない）。
- `c0e50d25` default allTools は第3巡で扱い済み。

### 第4巡スキャン追加パス
- `extensions/mcp/{resources,oauth,log,tools}.js`、`extensions/tool-search/tool.js`
- `mcp-native-http-transport.mjs`、`mcp-native-config-owner.mjs`（verify/retire）
- `extensions/codemode/execute.js`（heap / nested result）
- `mcp-webui-bridge.ts`（native 拒否のためのグローバルキー維持のみ・新規不具合なし）



---

## 9. 第5巡（深掘り・2026-10-04 追記）

対象 HEAD `11a2daf1`（第4巡と同）。第1–4巡掲載（新規32＋既存同根3）は再掲しない。焦点: OAuth discovery/AS fetch、MCP annotations×permission、namespace instructions、結果画像、roots、list_changed、temp/Session-Id。

### 9.1 [高] OAuth discovery / authorization server 取得が私設 https を拒否しない（SSRF・トークン向け）

| 項目 | 内容 |
|---|---|
| 重大度 | 高 |
| 場所 | `pi-mcp` `oauth/discovery.js`（`resourceMetadataUrl`・`authorization_servers[0]` へ `fetchMetadata`）、`oauth/flow.js` `secureEndpoint`（https または loopback のみ。**私設 IP は見ない**）、SDK `extensions/mcp/oauth.js`（refresh/authorize の `fetch` は timeout 付き `globalThis.fetch`）、LCP HTTP transport コメント「owner fetch MUST enforce destination policy」だが OAuth 経路に私設拒否は未実装 |
| 挙動 | 公開 MCP でも 401 の `WWW-Authenticate: resource_metadata=...` や PRM の `authorization_servers` で **任意 https（169.254.169.254 等）へメタデータ／トークン用 fetch** が走り得る。1.3 は mcp.json の endpoint URL。本項は **サーバ応答が誘導する二次 URL** |
| 修正方針 | OAuth 用 fetch に 1.3 と同型の解決後 IP 拒否。metadata URL は MCP origin に限定、または allowlist。LCP `captured.fetch` を OAuth にも強制 |

### 9.2 [中] MCP `destructiveHint` 等の annotations を permission-gate が参照しない

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | SDK `createMcpToolDefinition`（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` を tool annotations に載せる）、`extensions/leafcode-permission-gate`（`readOnlyHint`/`destructiveHint` **未参照**。`destructive` は git/shell 文言のみ） |
| 挙動 | サーバが destructive と宣言しても ask／system-safety の分岐に使われない。6.3（一般 MCP が ask UI 外）と直交し、**ヒントがあってもゲート材料にならない** |
| 修正方針 | annotations を requireApproval／read-only 短絡に接続。未提示は fail-closed または server ポリシー |

### 9.3 [中] `describeNamespace()` が MCP `instructions` を長さ制限なしで返す

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | MCP extension が `namespace.instructions = connection.instructions`、`codemode/execute.js` `describeNamespace` が **全文**を return。一方 `mcp_servers` 節は先頭行 250 字・全体 4096 字で打ち切り |
| 挙動 | スクリプトが `describeNamespace` すると巨大／誘導的 instructions がサンドボックスに入り、戻り値経由でモデル文脈へ載り得る。システム節の truncate と非対称 |
| 修正方針 | instructions に上限＋サニタイズ。model-facing 出力と同様に中間切り |

### 9.4 [中] `limitMcpContent` は text のみ 20KB 制限し、`image` ブロックは常に素通し

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `extensions/mcp/tools.js` `limitMcpContent`（truncate 時も `content.filter(type===image)` を結合。未 truncate 時は content 全体返却） |
| 挙動 | 巨大 base64 画像を複数返すと、テキストが短くてもモデル／UI に画像が丸ごと入る。7.7 は progress、8.8 はスクリプト側。本項は **モデル向け最終 content の画像** |
| 修正方針 | 画像枚数・合計バイト上限。超過は temp ファイル＋参照テキスト |

### 9.5 [中] MCP client が `roots/list` でセッション cwd の `file://` をリモートサーバにも広告する

| 項目 | 内容 |
|---|---|
| 重大度 | 中 |
| 場所 | `extensions/mcp/runtime.js` `new McpClient({ roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }] })` |
| 挙動 | HTTP MCP を含めサーバが `roots/list` すると **ローカル絶対パス相当の file URI** が渡る。ユーザ名・ディレクトリ構造の漏洩。stdio では想定内だがリモートでは過剰 |
| 修正方針 | HTTP/SSE では roots を空またはプロジェクト相対の仮名。オプトインでだけ実パス |

### 9.6 [低] `tools/list_changed` の `refreshTools` が fire-and-forget で登録と競合し得る

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | `runtime.js` `onNotification("notifications/tools/list_changed", () => { void this.refreshTools(client); })` → `onTools` → `registerTools` |
| 挙動 | 連続 list_changed やツール実行と並行すると、古い list の登録が新しい list の後に走り隠れツール／名前付けが一瞬不整合になり得る（最終的には後勝ち想定） |
| 修正方針 | 世代番号付きキューで直列化。in-flight refresh をキャンセル |

### 9.7 [低] MCP 一時ファイルの `mode: 0o600` が Windows で効かない／無視され得る

| 項目 | 内容 |
|---|---|
| 重大度 | 低（平台） |
| 場所 | `saveToTempFile`（`writeFile(..., { mode: 0o600 })` → `os.tmpdir()`） |
| 挙動 | コメントは「only the user may read」。Node on Windows では mode が ACL に十分反映されないことがあり、共有マシンで temp 結果が他ユーザから読める余地。パスはモデル向けメッセージに出る |
| 修正方針 | Windows で明示 ACL、または agent-dir 配下の専用 temp |

### 9.8 [低] `Mcp-Session-Id` を長さ・文字種チェック無しで以降の全リクエストに載せる

| 項目 | 内容 |
|---|---|
| 重大度 | 低 |
| 場所 | `pi-mcp` `streamable-http.js` `captureSession`（ヘッダ値をそのまま `sessionIdValue`、`headers()` で再送） |
| 挙動 | 極端に長い／制御文字を含む Session-Id を返すサーバで、以降のリクエストヘッダ肥大や中間装置の異常を起こし得る。認証バイパスというより DoS／相互運用 |
| 修正方針 | RFC 的な長さ・可視文字に制限。不正なら接続失敗 |

### 第5巡で確認して問題にしなかった点（簡潔）

- OAuth token/refresh エンドポイントは `secureEndpoint` で非 https（非 loopback）を拒否。ギャップは私設 https と discovery 誘導（9.1）。
- `mcp_servers` システム節の 250/4096 制限自体は健全。非対称は describeNamespace（9.3）。
- permission-gate の nested は shell wrapper 解析であり MCP annotations とは無関係。
- QuickJS worker に fetch/process/require 無し（第2巡確認の延長）。
- sampling/elicitation/prompts クライアント capability は未実装（ハンドラ無し）→ 新規欠陥ではなく未サポート。

### 第5巡スキャン追加パス
- `pi-mcp` `oauth/{discovery,flow,errors}.js`、`transports/streamable-http.js`、`protocol/content.js`
- `extensions/mcp/{oauth,runtime,tools}.js`、`extensions/codemode/execute.js`（describeNamespace）
- `extensions/leafcode-permission-gate/index.ts`（annotations 非参照）
- `pi-codemode` `runtime/{host,worker}.js`（再確認）

## スキャン範囲（触った主なパス）
- 第2巡追加: `@earendil-works/pi-codemode` host/worker、`pi-coding-agent` `extensions/mcp/runtime.js`、permission-gate `tool_call`、stdio spawn、activation env スナップショット
- 第3巡追加: progress/timeout/cancel、toolOwners/hidden、SessionExpired detach、stdio cwd、Bot `mcp` 名、prepare retire、Windows stdio lifecycle、`c0e50d25` default allTools
- 第4巡追加: resources widest/URI、tool_search×toToolExposure、HTTP Host ヘッダ、revision verify retire、mcp.log、OAuth callback host、codemode 非 truncate 結果
- 第5巡追加: OAuth discovery/AS SSRF、MCP annotations、describeNamespace instructions、image 非上限、roots file URI、list_changed 競合、temp mode、Mcp-Session-Id


- `backend/core/mcp-native-*.mjs`（session / extensions / runtime / http / stdio / env-commands / credentials）
- `backend/src/mcp-native-activation.mjs`
- `web/src/lib/pi/harness.ts`（createSession / deferred / loadout / reload / bot/subagent tools）
- `web/src/lib/pi/deferred-tools.ts`、`session-tool-selection.ts`
- `extensions/leafcode-subagents/.../mcp-direct-tool-allowlist.ts`、`pi-args.ts`
- `@earendil-works/pi-coding-agent@1.0.0` dist（`_isAllowedTool` / reload / createMcp|Codemode|ToolSearch）
- `docs/plans/codemode-effect.md`、旧 `BUGS-PERF-AUDIT-2026-10-03.md`（参照のみ）

## やらなかったこと

- 製品コードの修正・コミット・依存更新
- `BUGS-PERF-AUDIT-2026-10-03.md` への追記
- 実プロセスでの MCP サーバ接続・OAuth ブラウザフローの実行（第2–5巡も静的精読）
- 第1–4巡掲載知見の再測定・再掲（第5巡は未掲載のみ）
