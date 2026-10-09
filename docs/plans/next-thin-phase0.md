# Nextを薄くする：Phase0 API棚卸し・責務の固定

## 結論・対象範囲

Phase0開始時の `web/src/app/api/**/route.ts` **165ルート・258明示HTTP操作**を確認し、全操作の最終所有者を固定した。Phase4で7件の暗黙HEAD互換を明示exportへ移したため、現在の検証正本は **165ルート・265操作**。以下の操作数・表は追加HEAD込みで、Phase0の歴史的件数は258のまま保持する。

| 最終所有者 | 操作数 | 所有するもの |
|---|---:|---|
| Backend | 239 | 業務判断・入力検証・永続化・実行・ファイル認可・外部接続 |
| Host | 20 | プロセス/本体更新・ローカルUI・llama/翻訳サービスの制御 |
| Next | 6 | ブラウザ認証・Web識別・診断投影・Explorer遠隔起動拒否 |

**これは移行計画であり、239操作が未移行という意味ではない。** 既存のBackend/Host中継も含む。Phase0では実行コード・公開URL・認証条件・データを変更しない。

- 正本：[`next-thin-phase0.json`](next-thin-phase0.json)。操作単位のowner・phase・decision・contract・根拠、確認時点の直接importを保持。
- `owner` は最終的な処理/データの所有者。公開URLは引き続きNextに残し中継する。Nextが入口認証を行うこととBackendが業務を所有することは両立する。
- `observedImports` はPhase0時点の直接依存の観測値。既存中継の完全性・全推移依存・本番での実行所有を保証する値ではない。
- 表のPhaseは当該操作の責務整理を行う予定。Phase0の行は現状維持、Phase1はソース/ビルド基盤、Phase5は旧経路撤去なのでAPI行の追加移管先にはしない。
- 明示exportのみ計数。Nextによる暗黙HEAD/OPTIONSは別操作として水増しせず、元GET等の契約として検証する。
- 画面/layout、静的アセット、Host内部API、Backend内部APIは本一覧の列挙対象外。ただし移行先の責務は本書で固定する。

## 固定する責務

### Next
画面/アセット、WebUI token/Cookieの検証、ログイン制限、公開入口のOrigin/同一オリジン・CSRF対策、要求サイズ制限、安全な公開DTO投影、HTTP/SSE/binary中継。実行設定の正本・業務ファイル更新・SDK session・定期実行・Git・外部provider sessionは持たない。

### Backend
ドメイン入力検証・権限制約、全業務データ/設定の正本と更新、設定のlive反映、セッション/ルーティン、provider/MCP/peer認証・秘密保存、履歴/ファイル/生成・外部照会。Nextで入力を検証していても内部APIで再検証する。

### Host
Next/Backendの独立起動監視・停止再起動、本体更新とPi世代の適用、ブラウザ起動設定、ローカルfolder dialog、llama/翻訳サービスの状態・起動停止・load/install。Backend障害時でもHost管理経路は利用できるようNext→Hostを維持する。

### 共有層
`shared/` は通信契約・DTO・純粋な検証/変換に限定。秘密値・永続化・OS呼出・SDK singletonを置かない。UI向けtypesとBackend実装の逆依存を解消する。

## メソッド/複合操作の例外（所有者確定済み）

| 対象 | 決定・維持する挙動 |
|---|---|
| `POST /api/auth/webui` | NextがCookieとログイン制限を所有。provider/MCPログインとは分離。 |
| `GET /api/health` | NextがWeb公開readinessと診断投影を所有し、実行状態はBackend/Host DTOから合成。現行の匿名向け秘匿化と認証済み応答を維持。Backend停止でもWeb生存と実行readyを区別する。 |
| `GET /api/backend/status` | Nextが接続/世代診断のみ所有。内部token・PIDをブラウザへ返さない。 |
| `GET/OPTIONS /api/host-probe` | Webプロセス識別なのでNextに残す。許可するprivate Origin/PNA応答を維持。Hostへ移さない。 |
| `GET /api/browse/dirs` | Backendが一覧・許可ルート・quick accessを所有。OS読取という理由だけでHostへ移さない。 |
| `POST /api/browse/dirs` | 対話folder dialogはHost所有。新しいHost APIはloopback/ローカル要求制約を必須とし、遠隔ブラウザからの無制限起動にしない。選択pathはBackendで再検証。 |
| `GET /api/{projects,tasks}/[id]/explorer` | BackendがID→pathを解決、Nextは安全なcontrolUrlを付加。起動操作はブラウザ→loopback Host経路のまま。 |
| `POST /api/projects/[id]/explorer` | Nextの403拒否を残す。遠隔起動の中継を新設しない。 |
| `GET/POST /api/build-info` | 現在POSTが本体repoをpullするため、GETの更新情報と併せHostへ移す。ユーザーrepo Git APIとは別。既存fast-forward限定・更新後の再起動/世代固定を維持。 |
| `/api/pi/{latest-version,update}` | Hostが更新情報・予約/適用を所有。latest照会を自動更新へ結び付けない。 |
| `/api/llama-server/**` | Hostがモデル一覧・起動/停止・load状態を所有。起動後のBackend model/health cache無効化は所有者側の通知に分離し、HostにSDKを持ち込まない。 |
| `/api/settings/llama-server-config` | 保存する設定の正本はBackend。Hostには検証済みの設定snapshot/revisionを渡す。起動時設定と永続化の所有者を混同しない。 |
| `/api/translation/**` | Hostの既存control経路を薄く中継。導入/変換/override等の判断と状態はHost。 |
| `/api/peer-auth/{list,resolve,usage}` | WebUI Cookieゲートの例外を維持。Backendがpeer bearer・grant scope・秘密解決を検証。内部bearerとpeer bearerを別の信頼境界として伝える。 |
| `/api/providers/[id]/login/events` | 認証sessionはBackend、SSEはPhase4で中継。Nextにprovider認証実体を残さない。 |
| `/api/profile` | Backup/import/restore/reset・package復元はBackend。GETはbackupsならJSON、通常gzipなのでPhase4。現在productionで拒否するmutationもPhase2の移行対象。復旧・サイズ制限・maintenanceを省略しない。 |
| `/api/settings/tts/voices` | JSON外部catalog照会はPhase3。TTS設定保存はPhase2、音声bytes生成/配信はPhase4。 |
| `/api/projects/[id]/icon` | JSON一覧でなく画像bytes配信なのでPhase4。v hash一致時のprivate immutable cache、不一致時のno-cache・mime/nosniffを維持。 |
| `/api/sysmon/usage` | 読取sampling/cacheはBackend。取得失敗時の200/available:falseを維持。 |
| `/api/unread` | サーバー既読状態はBackend。ブラウザ内表示cacheとは分離。 |

## 契約・移行時の検証

以下は現行コードで確認した挙動と、後続Phaseの保存条件。Phase0では新しい認証/timeout仕様を実装しない。

| 項目 | 固定方針・現行根拠 |
|---|---|
| 公開認証 | `web/src/proxy.ts` と `webui-auth-shared.ts` のrequired条件・例外一覧を維持。匿名アクセス可否を移行で広げない。CSRF/同一オリジン制約はNext入口と所有者側の権限制約を分け、既存個別チェックを失わない。 |
| 内部認証 | loopback Backend、内部token、protocol/generationチェックを維持。tokenはNext/Backend間だけ、ブラウザへ渡さない。Host controlの既存制約も保持。 |
| peer認証 | peerのAuthorizationを内部Authorizationで上書きして消さない。専用DTO/headerをNextが生成し、Backendでpeer tokenを別途検証。クライアント由来の内部認証/context headerは採用しない。resolveの資格情報は承認済みpeerにだけ既存scopeで返し、一般ブラウザ向けの秘匿化DTOと混同しない。 |
| 部分成功 | `settings/[key]` は現在「保存後に反映失敗」で503。Phase2ではBackendが保存/revision/反映状態を明示し、失敗を未保存と誤認させない。 |
| 入出力 | URL・query・params・JSON/multipart・レスポンス形・status・cache headersを維持。分類ごとの入力/出力/副作用は下表、正確なフィールド/エラー条件はJSONのsourceを実装時に再確認して契約テストへ固定する。 |
| エラー | 現行の400/401/403/404/409/413/429/5xx、200＋エラーDTOなども無断統一しない。内部例外・秘密・OS pathを公開DTOへ新たに漏らさない。 |
| 通常Backend中継 | `backend-client.ts` の通常10秒・prompt60秒が現行基準。各処理の上限に合わせて個別設定し、生成60秒等を通常10秒で切らない。成功応答の実行時schema検証を追加する。 |
| Host中継 | 現行activity/status約3秒、通常制御約5秒、translation/reasoning65秒。folder dialog120秒、build-info pull60秒などを実処理deadlineとHTTP待機deadlineに分ける。共通timeoutへ一律変更しない。 |
| キャンセル | JSON要求/配信はブラウザ切断を伝播。llama load等の既存継続operationはHTTP待機だけ止め、実行自体を勝手に中止しない。 |
| 再試行 | Git・更新・import・課金/credit消費・prompt等は盲目的再送禁止。操作ID/revisionと結果照会による整合性を実装時に確保。 |
| binary/SSE | Range/HEAD・Content-Type・Content-Disposition・ETag・キャッシュ・SSE初期snapshot/再接続を維持。Nextで全体bufferしない。 |
| 障害 | Backend停止/世代不一致をNext内実行で隠さない。Next再起動で実行/ルーティンを停止しない。Hostは独立管理。 |

### 分類別の入出力・副作用
| 分類 | 対象・入力 | 応答 | 副作用 | 原則 |
|---|---|---|---|---|
| edge | ブラウザ認証・Web識別・入口診断<br>token/Cookie・Origin・診断要求 | Cookie・識別ID・health DTO | Cookie・ログイン制限 | Nextに残す。SDK・業務データの直接参照だけ除去。 |
| host-control | 起動監視・本体更新・ブラウザ設定・翻訳・llama制御<br>action・起動設定・翻訳text・更新予約 | 制御状態・結果 | 起動停止・更新予約・モデル導入 | Next→Hostの薄い中継。Web内の制御判断をHostへ移し、Backendの生存に依存させない。 |
| settings | 通常/実行/安全/Jev/メモリ/TTS設定<br>key/value・設定DTO・移行要求 | snapshot・保存/反映結果 | 永続化・live反映・資格情報移行 | Backendが保存と反映を所有。Nextは入口ポリシーのみ。 |
| definitions | Agent/Skill/Extension・共通Markdown・プロンプト移行<br>name・enabled・content・定義DTO・移行ファイル | 一覧・保存/reload結果 | ファイル更新・context reload | 定義の更新とlive反映をBackendへ集約。 |
| credentials | account/provider/MCP/model/CodexBar/peer認証<br>ID・認証回答・cookie/鍵・設定・peer bearer | 秘匿化DTO・認証状態・使用量 | 秘密保存・OAuth・grant・外部照会 | 秘密情報・認証セッションはBackend所有。peer独自認証を維持。 |
| runtime | project/task/Bot/Room/routine・履歴・承認・質問<br>ID・prompt・model・action・回答・cursor | 状態・履歴・操作結果DTO | 実行停止・CRUD・定期実行・履歴更新 | 既存中継も対象。Web側の判断・業務読取・開発ローカル経路を撤去。 |
| git | ユーザーGit・diff<br>directory・paths・branch・commit・PR条件 | 結果・履歴・diff | index/履歴/remote更新・CLI | パス制限・引数検証をBackendで再適用。副作用あり操作を自動再送しない。 |
| generation | タイトル・次タスク/アクション・進捗・助言・コミット文・検索/preview<br>ID・context・条件・URL・query | 生成結果・モデル情報・検索/preview DTO | 推論・外部接続・metadata更新・cache | 直接推論・外部照会・キャンセル・cacheもBackend所有。 |
| filesystem | ファイル一覧・アイコン・作業path解決<br>ID・path・一覧条件 | 許可済み一覧・アイコン・path DTO | OS/ファイル読取・アイコン抽出 | 実パス検証をBackendで実施。Explorer起動はHostのloopback制約を維持。 |
| stream | SSE・メディア・画像・外部画像・音声<br>ID・cursor・Range・URL・音声要求 | SSE/binary・配信ヘッダー | 外部接続・ファイル読取・音声生成 | 内容生成・ファイル認可はBackend。Nextはbufferせず中継し切断を伝播。 |
| profile | profile backup/import/restore/reset<br>multipart archive・backup ID・action | archive・一覧・結果 | 一括置換・package復元・maintenance | productionで拒否中の変更経路も対象。停止/反映・復旧をBackendで管理。 |
| notifications | 通知・Pushover設定/テスト送信<br>設定DTO・送信条件 | 秘匿化設定・送信結果 | 秘密保存・外部通知 | 認証/ローカル要求制限はNextで維持し許可済みcontextをBackendへ渡す。 |
| observation | システム使用率・既読状態<br>取得・既読更新 | usage snapshot・既読DTO | OS読取・既読永続化 | sampling/cacheと永続化はBackend。Hostの起動制御とは区別。 |

## Phase1以降の実行順・完了条件

| Phase | 範囲 | 完了条件 |
|---|---|---|
| Phase0 | 本一覧・所有者固定 | 全明示HTTP操作に一意の所有者・実施Phaseがあり、実装一覧と一致 |
| Phase1 | Backendソース/ビルド独立化・開発の独立Backend化 | WebソースからBackend実行コードを分離し、UI変更でBackend成果物を無効化しない |
| Phase2 | settings/notifications/profile mutation | Nextが設定の正本を更新せず、保存/反映/復旧状態をBackendが管理 |
| Phase3 | JSON業務API・Host制御・診断 | Nextから業務読取/更新・Git・外部照会・制御判断を撤去 |
| Phase4 | SSE/binary/profile export | 配信・生成・認可を所有者に移し、中継のメモリ/切断/Range/再接続を検証 |
| Phase5 | 旧ローカル経路/不要SDK依存の撤去・最終検証 | Next停止/再起動でもBackend実行継続、禁止importチェックが通る |

各機能群で「契約テスト→所有者API→Next中継→旧経路撤去→障害/認証/回帰テスト→独立レビュー」を完結させる。Phase1では巨大harness全面分割、DB刷新、Vite移行を行わない。

## 全API所有者一覧

以下はJSON正本から生成した表。追加/削除/メソッド変更時はJSONと表を更新する。

| 公開ルート | メソッド → 最終所有者 / 実施Phase | 分類 |
|---|---|---|
| `/api/accounts/[id]/anthropic-baseline` | POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/accounts/[id]/anthropic-cookie` | POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/accounts/[id]/auth-status` | GET → Backend / Phase3 | credentials |
| `/api/accounts/[id]/ollama-cookie` | POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/accounts/[id]/opencode-go-cookie` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/accounts/[id]/openrouter-baseline` | POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/accounts/[id]/openrouter-credits` | POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/accounts/[id]` | PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/accounts` | GET → Backend / Phase3<br>PATCH → Backend / Phase3<br>POST → Backend / Phase3 | credentials |
| `/api/agents/[name]` | GET → Backend / Phase3<br>PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | definitions |
| `/api/agents` | GET → Backend / Phase3<br>POST → Backend / Phase3 | definitions |
| `/api/agents-md` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | definitions |
| `/api/auth/webui` | POST → Next / Phase0 | edge |
| `/api/backend/status` | GET → Next / Phase3 | edge |
| `/api/backend/tasks` | GET → Backend / Phase3 | runtime |
| `/api/bots/[id]/abort` | POST → Backend / Phase3 | runtime |
| `/api/bots/[id]/code-requests` | GET → Backend / Phase3<br>POST → Backend / Phase3 | runtime |
| `/api/bots/[id]/code-session` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>PATCH → Backend / Phase3 | runtime |
| `/api/bots/[id]/events` | GET → Backend / Phase4 | stream |
| `/api/bots/[id]/intercom` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | runtime |
| `/api/bots/[id]/prompt` | POST → Backend / Phase3 | runtime |
| `/api/bots/[id]/revert` | POST → Backend / Phase3 | runtime |
| `/api/bots/[id]` | GET → Backend / Phase3<br>PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | runtime |
| `/api/bots/[id]/routines/[routineId]` | GET → Backend / Phase3<br>PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | runtime |
| `/api/bots/[id]/routines/[routineId]/run` | POST → Backend / Phase3 | runtime |
| `/api/bots/[id]/routines` | GET → Backend / Phase3<br>POST → Backend / Phase3 | runtime |
| `/api/bots/events` | GET → Backend / Phase4 | stream |
| `/api/bots/rooms/[id]/code` | POST → Backend / Phase3 | runtime |
| `/api/bots/rooms/[id]/events` | GET → Backend / Phase4 | stream |
| `/api/bots/rooms/[id]/files/[file]` | HEAD → Backend / Phase4<br>GET → Backend / Phase4 | stream |
| `/api/bots/rooms/[id]/images/[file]` | HEAD → Backend / Phase4<br>GET → Backend / Phase4 | stream |
| `/api/bots/rooms/[id]/prompt` | POST → Backend / Phase3 | runtime |
| `/api/bots/rooms/[id]/revert` | POST → Backend / Phase3 | runtime |
| `/api/bots/rooms/[id]` | GET → Backend / Phase3<br>PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | runtime |
| `/api/bots/rooms` | GET → Backend / Phase3<br>POST → Backend / Phase3 | runtime |
| `/api/bots` | GET → Backend / Phase3<br>POST → Backend / Phase3 | runtime |
| `/api/bots/sidebar` | GET → Backend / Phase3 | runtime |
| `/api/bots-md` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | definitions |
| `/api/browse/dirs` | GET → Backend / Phase3<br>POST → Host / Phase3 | filesystem |
| `/api/browse/icon` | GET → Backend / Phase3<br>POST → Backend / Phase3 | filesystem |
| `/api/build-info` | POST → Host / Phase3<br>GET → Host / Phase3 | host-control |
| `/api/cache-warming` | GET → Backend / Phase2<br>PATCH → Backend / Phase2 | settings |
| `/api/codexbar/providers` | GET → Backend / Phase3<br>PUT → Backend / Phase3 | credentials |
| `/api/codexbar/reset-credits` | GET → Backend / Phase3<br>POST → Backend / Phase3 | credentials |
| `/api/codexbar/usage` | GET → Backend / Phase3 | credentials |
| `/api/compaction-settings` | GET → Backend / Phase2<br>PATCH → Backend / Phase2 | settings |
| `/api/design-md` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | definitions |
| `/api/diff/files` | GET → Backend / Phase3 | git |
| `/api/extensions/[name]` | PATCH → Backend / Phase3 | definitions |
| `/api/extensions` | GET → Backend / Phase3 | definitions |
| `/api/git/branches` | GET → Backend / Phase3 | git |
| `/api/git/commit` | POST → Backend / Phase3 | git |
| `/api/git/commit-message` | POST → Backend / Phase3 | generation |
| `/api/git/init` | POST → Backend / Phase3 | git |
| `/api/git/log` | GET → Backend / Phase3 | git |
| `/api/git/merge` | POST → Backend / Phase3 | git |
| `/api/git/pr` | GET → Backend / Phase3<br>POST → Backend / Phase3 | git |
| `/api/git/pull` | POST → Backend / Phase3 | git |
| `/api/git/push` | POST → Backend / Phase3 | git |
| `/api/git/repositories` | GET → Backend / Phase3 | git |
| `/api/git/rm` | POST → Backend / Phase3 | git |
| `/api/git/show` | GET → Backend / Phase3 | git |
| `/api/goal-loop/active` | GET → Backend / Phase3 | runtime |
| `/api/health` | GET → Next / Phase3 | edge |
| `/api/host/activity` | POST → Host / Phase3 | host-control |
| `/api/host/browser-config` | GET → Host / Phase3<br>POST → Host / Phase3 | host-control |
| `/api/host/restart` | POST → Host / Phase3 | host-control |
| `/api/host/webui-auth` | GET → Host / Phase3<br>POST → Host / Phase3 | host-control |
| `/api/host-probe` | GET → Next / Phase0<br>OPTIONS → Next / Phase0 | edge |
| `/api/jev-model/legacy-credentials` | GET → Backend / Phase2<br>DELETE → Backend / Phase2 | settings |
| `/api/jev-model` | GET → Backend / Phase2<br>PUT → Backend / Phase2 | settings |
| `/api/link-preview/image` | HEAD → Backend / Phase4<br>GET → Backend / Phase4 | stream |
| `/api/link-preview` | POST → Backend / Phase3 | generation |
| `/api/llama-server/[action]` | GET → Host / Phase3<br>POST → Host / Phase3 | host-control |
| `/api/llama-server/ensure-loaded` | POST → Host / Phase3 | host-control |
| `/api/llama-server/models` | GET → Host / Phase3 | host-control |
| `/api/mcp/[name]/auth` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/mcp/[name]` | PATCH → Backend / Phase3 | credentials |
| `/api/mcp` | GET → Backend / Phase3<br>POST → Backend / Phase3 | credentials |
| `/api/memory-search` | POST → Backend / Phase3 | generation |
| `/api/memory-settings` | GET → Backend / Phase2<br>PUT → Backend / Phase2 | settings |
| `/api/models` | GET → Backend / Phase3 | credentials |
| `/api/notifications` | GET → Backend / Phase2<br>PUT → Backend / Phase2 | notifications |
| `/api/peer-auth/import` | GET → Backend / Phase3<br>POST → Backend / Phase3 | credentials |
| `/api/peer-auth/list` | GET → Backend / Phase3 | credentials |
| `/api/peer-auth/peers` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/peer-auth/resolve` | POST → Backend / Phase3 | credentials |
| `/api/peer-auth/usage` | POST → Backend / Phase3 | credentials |
| `/api/pi/latest-version` | GET → Host / Phase3 | host-control |
| `/api/pi/update` | GET → Host / Phase3<br>POST → Host / Phase3 | host-control |
| `/api/profile` | HEAD → Backend / Phase4<br>GET → Backend / Phase4<br>POST → Backend / Phase2<br>PATCH → Backend / Phase2<br>PUT → Backend / Phase2<br>DELETE → Backend / Phase2 | profile |
| `/api/projects/[id]/explorer` | GET → Backend / Phase3<br>POST → Next / Phase0 | filesystem |
| `/api/projects/[id]/files` | GET → Backend / Phase3 | filesystem |
| `/api/projects/[id]/icon` | HEAD → Backend / Phase4<br>GET → Backend / Phase4 | stream |
| `/api/projects/[id]/next-task` | POST → Backend / Phase3 | generation |
| `/api/projects` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | runtime |
| `/api/prompts/transfer` | POST → Backend / Phase3 | definitions |
| `/api/provider-models/[key]` | PATCH → Backend / Phase3 | credentials |
| `/api/provider-models/order` | PATCH → Backend / Phase3 | credentials |
| `/api/provider-models` | GET → Backend / Phase3 | credentials |
| `/api/providers/[id]/base-url` | GET → Backend / Phase3<br>PUT → Backend / Phase3 | credentials |
| `/api/providers/[id]/login/answer` | POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/providers/[id]/login/callback` | POST → Backend / Phase3 | credentials |
| `/api/providers/[id]/login/events` | GET → Backend / Phase4 | credentials |
| `/api/providers/[id]/login` | POST → Backend / Phase3 | credentials |
| `/api/providers/[id]/logout` | POST → Backend / Phase3 | credentials |
| `/api/providers/[id]` | PATCH → Backend / Phase3 | credentials |
| `/api/providers` | GET → Backend / Phase3 | credentials |
| `/api/pushover` | GET → Backend / Phase2<br>PUT → Backend / Phase2<br>POST → Backend / Phase2 | notifications |
| `/api/settings/[key]` | GET → Backend / Phase2<br>PUT → Backend / Phase2 | settings |
| `/api/settings/hang-timeout` | GET → Backend / Phase2<br>PATCH → Backend / Phase2 | settings |
| `/api/settings/intercom` | GET → Backend / Phase2<br>PATCH → Backend / Phase2 | settings |
| `/api/settings/llama-server-config` | GET → Backend / Phase2<br>PUT → Backend / Phase2 | settings |
| `/api/settings` | GET → Backend / Phase2 | settings |
| `/api/settings/system-safety` | GET → Backend / Phase2<br>PATCH → Backend / Phase2 | settings |
| `/api/settings/transfer` | DELETE → Backend / Phase2<br>GET → Backend / Phase2<br>POST → Backend / Phase2 | settings |
| `/api/settings/tts` | GET → Backend / Phase2<br>PATCH → Backend / Phase2 | settings |
| `/api/settings/tts/voices` | GET → Backend / Phase3 | settings |
| `/api/skills/[name]` | PATCH → Backend / Phase3 | definitions |
| `/api/skills` | GET → Backend / Phase3<br>POST → Backend / Phase3 | definitions |
| `/api/soul-md` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | definitions |
| `/api/sysmon/usage` | GET → Backend / Phase3 | observation |
| `/api/tasks/[id]/abort` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/agent` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/bookmarks` | GET → Backend / Phase3<br>PUT → Backend / Phase3<br>DELETE → Backend / Phase3 | runtime |
| `/api/tasks/[id]/compact/abort` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/compact` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/events` | GET → Backend / Phase4 | stream |
| `/api/tasks/[id]/explorer` | GET → Backend / Phase3 | filesystem |
| `/api/tasks/[id]/files` | GET → Backend / Phase3 | filesystem |
| `/api/tasks/[id]/fork` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/goal-loop` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>PATCH → Backend / Phase3 | runtime |
| `/api/tasks/[id]/goal-loop-auto-model` | PUT → Backend / Phase3 | runtime |
| `/api/tasks/[id]/image` | HEAD → Backend / Phase4<br>GET → Backend / Phase4 | stream |
| `/api/tasks/[id]/media` | GET → Backend / Phase4<br>HEAD → Backend / Phase4 | stream |
| `/api/tasks/[id]/message-image` | HEAD → Backend / Phase4<br>GET → Backend / Phase4 | stream |
| `/api/tasks/[id]/messages` | GET → Backend / Phase3 | runtime |
| `/api/tasks/[id]/model` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/next-action` | POST → Backend / Phase3 | generation |
| `/api/tasks/[id]/permission/advice` | POST → Backend / Phase3 | generation |
| `/api/tasks/[id]/permission` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/progress` | POST → Backend / Phase3 | generation |
| `/api/tasks/[id]/promote` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/prompt` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/question` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/revert` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]` | GET → Backend / Phase3<br>PATCH → Backend / Phase3<br>DELETE → Backend / Phase3 | runtime |
| `/api/tasks/[id]/search` | GET → Backend / Phase3 | runtime |
| `/api/tasks/[id]/subagents` | GET → Backend / Phase3 | runtime |
| `/api/tasks/[id]/supervisor` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/thinking` | POST → Backend / Phase3 | runtime |
| `/api/tasks/[id]/title` | POST → Backend / Phase3<br>PATCH → Backend / Phase3 | generation |
| `/api/tasks/[id]/unrevert` | POST → Backend / Phase3 | runtime |
| `/api/tasks` | GET → Backend / Phase3<br>DELETE → Backend / Phase3<br>POST → Backend / Phase3 | runtime |
| `/api/tools-md` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | definitions |
| `/api/translation/install` | POST → Host / Phase3 | host-control |
| `/api/translation/override` | POST → Host / Phase3 | host-control |
| `/api/translation/reasoning` | POST → Host / Phase3 | host-control |
| `/api/translation/status` | GET → Host / Phase3 | host-control |
| `/api/tts/synthesize` | POST → Backend / Phase4 | stream |
| `/api/typesafe-baseline` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/typesafe-cookie` | GET → Backend / Phase3<br>POST → Backend / Phase3<br>DELETE → Backend / Phase3 | credentials |
| `/api/unread` | GET → Backend / Phase3<br>PUT → Backend / Phase3 | observation |
| `/api/user-md` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | definitions |
| `/api/workflow-md` | GET → Backend / Phase3<br>PATCH → Backend / Phase3 | definitions |

## 再検証

```text
node scripts/check-api-ownership.mjs
node --test scripts/check-api-ownership.test.mjs
git diff --check
```

チェッカーはTypeScript ASTから実装の明示HTTP exportを列挙し、ルート/メソッドの欠落・余分・重複、無所有・不正Phase/contract、Markdown表の不一致を検出する。所有者の意味的な妥当性は本書の責務/例外に照らしてレビューする（自動検査が保証するのは網羅性と構造）。
