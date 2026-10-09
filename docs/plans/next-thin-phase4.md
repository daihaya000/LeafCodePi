# Phase4 — ファイル配信・ストリーム移管

## 今回の単位: Taskローカル画像・動画・音声

Phase0のPhase4対象は14経路・15操作。今回の移管は `tasks/[id]/image` GET、`tasks/[id]/media` GET/HEADの2経路・3操作。画像の従来のNext自動HEAD互換を維持するため、画像にも明示的なHEAD中継を設けた。Phase4全体は未完了。

- Nextは `relayTaskFileStream` の単一中継。ファイルパス・Task/workspace・拡張子・画像署名を判断せず、配信ファイル・SDKを参照しない。元クエリとRange/If-Rangeを保持し、本文をpull時に1チャンクずつ転送する。`arrayBuffer/text/json`等の全体読み取りはない。
- Backendは `/internal/file-stream/tasks/<id>/{image,media}` を所有。private bearer/protocol、readiness、WebUIアクセスをIO前に確認する。Nextのgeneration/auth拒否にfallbackはない。
- 既存のTask/Project保存情報・許可ルート・canonical path・UNC/URL/ドライブ相対拒否を再利用。canonical名と開いたFDのdev/inoを再照合し、末端symlink・special file・サイズ・署名を検証する。開いた同じFDから読む。読取中のサイズ/mtime変更はストリームを失敗させる（原子的なファイルsnapshotの保証ではない）。
- 動画/音声512MiB、画像32MiB。最大32配信、読取64KiB、WebストリームhighWaterMark=0。ペイロードのサイズに比例するアプリケーションバッファを確保しない。native socketはdrainを待ち、45秒停滞した接続を破棄する。
- 単一Range、suffix/open-ended、206/416、Content-Range/Lengthを維持。HEADはFDを閉じ本文を返さない。validatorを発行しないためIf-Range付き要求は従来どおり全体200を返す。画像にも同じRangeを適用する。
- Consumer cancel/AbortSignal/HTTP切断はNext→Backendへ伝播し、reader・FD・listener・drain timerを解放する。ファイル読取だけを止め、Taskの実行・エージェントは停止しない。
- private/protocol/set-cookie等はブラウザへ転送せず、配信ヘッダをallowlistする。診断カウンタはprivate runtime exportのみでHTTPには公開しない。

## 検証

- Web46件、native server78件、契約/AST/ストール制御7件、実プロセス2段HTTP1件、計132件成功。Backend/Web型チェック成功。
- 本物のBackend runtime実装＋native HTTP serverと、別プロセスにbundleした実Next relay実装＋Node HTTP adapterを使用。これはNext production server全体の計測ではない。保存Task・隔離data/agent/APPDATA・sparse WAVを用い、実モデル/ユーザーデータ/ユーザーサービスを操作しない。
- 512MiBを2回、計1GiBを全量配信。停止consumerのbackpressure、Range/HEAD、private bearer/WebUI拒否、61切断、再接続を確認。最後のBackend active/FDと中継activeはいずれも0。
- 25ms間隔のプロセス計測でピークRSS増分はBackend67,715,072 bytes、relay24,678,400 bytes、heap増分は13,078,712 / 1,869,736 bytes。閾値はRSS128MiB、heap48MiB、external96MiB。OS/GC/HTTPバッファを含むため、固定の64KiBだけを消費すると主張しない。有限の試験であり時間無制限の証明ではない。
- productionの45秒drain期限は短縮20msの同じtransportテストで解放を確認。32枠上限、未消費時のpayload読取0、画像/音声署名、パス拒否、変更中ファイルの失敗、Cancel後FD0を検証。
- 初回の実fixtureは認証設定、欠落パスの既存403期待値、adapterによるprivate protocolヘッダ再付加が不適切だった。fixtureを実認証・既存境界・素のHTTP adapterへ修正し再検証した。全体suiteは未実行。

## 追加単位: Room添付file/image

- `bots/rooms/[id]/files/[file]` と `images/[file]` のGETをBackendへ移管。Next自動HEAD互換の明示HEADも同じ中継。累計4経路・Phase0掲載5操作を移管済み（追加の明示HEADは3操作）。
- 共通private ingress・WebUI認証・generation・最大32配信・64KiB読取・pull/HWM0・drain期限・切断制御を再利用。Roomも単一/suffix Range、416、If-Range全体200を提供する。
- Backendのみが隔離Root内のRoom JSON・生成名・添付FDを検証する。ファイルは既存どおりlive messagesへの登録、画像はRoom存在＋生成名の権限契約（live履歴のoverflow/reset後も既存画像URLは有効）。Room/sessionの書換え、SDK再hydration、履歴scanはしない。
- MIME・日本語添付名・immutable/private cacheを維持。MIMEの安全なASCIIパラメータを制限せず保持し、制御文字は拒否。filenameはUTF-8/RFC5987形式。画像は拡張子と署名を照合し、nosniff/same-originを追加する。
- 添付8MiB（保存側の既存上限）。Room JSONは新しく8MiBを上限にし、超過は503で拒否する（巨大な既存Roomの配信は制限される）。メタデータの読取は64KiB刻み、同時2件・再利用buffer合計16MiB以下、待機は共通32枠内で有界。解析Roomは添付権限の確認後に保持せず、配信へ持ち越すのはMIME/filenameヘッダだけ。取消しで待機listener/枠を解放する。JSONはBackendでのみ有界bufferに読むが、添付本文はBackend/Nextとも全体bufferしない。
- canonical名をFDのdev/inoと再照合し、Roomディレクトリのsymlink/Windows junctionによる他Room・Root外への差替えを拒否。FDの読取中size/mtime検査は共通実装で継続する。原子的snapshot・OS全体のFD計測・無期限の保証ではない。

### Room検証

- Web53件、Room store/normalize・native server104件、契約/AST/ストール10件、Task/Room実2段HTTP各1件、計169件。Backend/Web型チェック成功。前回Taskの1GiB/61切断も再検証し、active/FD/中継activeは0。
- Roomは8MiBを4並列×8巡、計256MiB配信。32本文切断、7MiB metadataの24要求取消し、Range/HEAD/認証/画像、Backend・relay再起動後の再取得を実証。最後の配信active/添付FD/metadata active/metadata待機/relay activeはすべて0、metadata peakは2以下。
- プロセスRSS/heap/externalを25msで採取。閾値RSS128MiB、heap64MiB、external96MiB。最終計測のRSS増分はBackend68,300,800 / relay52,830,208 bytes、heap13,973,472 / 3,963,568、external67,904,928 / 52,625,626 bytes。実Backend runtimeと実Next relay＋HTTP adapterであり、Next production server全体・SSEの長時間計測ではない。
- 原因: メタデータbufferを要求ごとに再確保した版は、読取を64KiB刻みにした再検証でexternal増分124,825,632 bytesとなり96MiB閾値に抵触した（RSS増分73,805,824 bytes、heap17,041,632 bytes）。同時2枠でbufferを再利用し、閾値を緩めず再検証を通した。再利用bufferの合計も16MiB以下をassertする。\n- 原因: 最初のRoom再起動fixtureがSIGTERM終了済みchildをexitCodeだけで生存扱いし、cleanupが既に発生したexitを待ち30秒timeoutになった。signalCodeとIPC接続状態も確認するよう修正。再実行で再起動・cleanup成功、旧fixtureプロセス残留なしを確認した。

## 追加単位: 保存Project icon・preview画像

- `projects/[id]/icon` と `link-preview/image` のGETを共通private streamへ移管し、既存Next自動HEAD互換の明示HEADを追加。累計6経路・Phase0掲載7操作を移管済み（互換HEADは追加5操作）。Nextは各経路1回のopaque relayで、store・画像decode・network・本文全体bufferを持たない。
- Project iconはBackend限定 `AppStore.getProjectIcon` でimmutable文字列だけを読む。既存CRUDのclone契約・mtime/ctime/ino再読込を維持する。base64は要求offsetの3byte/4文字境界に合わせ、1pull最大64KiBだけ復号（内部decode最大65,538bytes）。Range各alignment・suffix/416・HEAD・If-Range全体200を検証。現在versionのimmutable/private cache、旧versionのno-cache、日本語ID、ICO両MIMEを維持する。
- icon/previewは2MiB以下。iconにcanonical base64・画像署名照合を追加し、保存上限を超える既存値・壊れた画像は拒否する。previewは既存128ID/8MiB cache/8同時fetch/6秒期限/public DNS・redirect・接続pin・認証情報非転送を再利用。画像本体は有界な既存Backend cacheにあるが、Nextへはbase64 JSONにせず64KiB刻みで転送する。
- previewのprivate JSON登録とNext側base64復元を削除し、旧JSON ingressは404でfallbackしない。no-referrer/nosniff/same-origin/private 300秒cacheを維持。IDは一時的でBackend再起動後404、Project iconは保存情報から再取得できる。
- preview fetchは待機者を参照カウントする。1人の切断は他の待機者を止めず、最後の取消しだけnetwork AbortSignalへ伝播する。取消しのopaque IDは期限内の再接続に利用可能。取消し済みjobのcleanupを待つ再接続も独立に取消せる。hot-reload由来の旧pendingは既存6秒期限で終わるが、新controllerで遡って取消す保証はない。
- Web148件、native/契約/AST224件、AppStore CRUD/並行更新/immutable getter17件、Task/Room/asset実2段HTTP各1件の計392件成功。両型チェック成功。Task1GiB/61切断、Room256MiB/32切断＋24metadata取消しを再検証し、FD/active/待機は0。
- assetは2MiBを両経路で4並列×32巡、計256MiB、64本文切断。Range/HEAD/auth/cache・再起動後の保存icon再取得とpreview ID失効を実証。最後の配信active/添付FD/preview fetch/待機/relay activeは0、意図的なpreview cacheは2MiB。
- 修正後のasset計測でRSS増分Backend67,665,920 / relay41,099,264 bytes、heap17,259,376 / 4,784,128、external67,768,340 / 33,885,204。閾値RSS128MiB、heap48MiB、external96MiBを維持。実Backendと実Next relay＋HTTP adapterによる有限の計測。Next production全体、長時間SSE、実publicサイトのfetchは未測定（network取消しはsignal対応mockと既存public transport境界テストで確認）。
- 原因: 初版は `getProject` が2MiB iconを含むproject全体を要求ごとにstructuredCloneし、反復配信でheap増分72,105,232bytes（閾値48MiB）、RSS106,430,464bytesとなった。immutable文字列専用getterで複製を避け、閾値を緩めず再検証した。旧JSON経路のテスト期待値200/503も、登録削除後の404へ更新した。

## 追加単位: Room会話・Bot一覧SSE

- `bots/rooms/[id]/events` と `bots/events` のGETをBackendの `/internal/live-events` へ移管。累計8経路・Phase0掲載9操作。Nextはdevelopmentでもopaque中継だけで、Room/store/SDK購読・履歴解析・snapshot整形・ローカルfallbackを持たない。
- Roomの初回全snapshot、append/update時のmessages差分、履歴reset時の全snapshot、attentionだけの変更時のroomReusedを維持。BackendのRoom変更とmember/linked Code Task snapshotを購読し、2秒のdisk safety-netを併用する。再接続では常に現在の全snapshotを送り、Last-Event-IDはopaque転送のみ（履歴replay保証はない）。
- Bot一覧はCode snapshot・routineに加え、従来productionで流れていた `task_dirty` を維持。SidebarとGlobalAttentionProviderがこれを使うため、Code/routineだけへ狭めない。従来public中継と同様、token単位task_streamを流さない。Bot一覧の取りこぼしは既存client hubのonOpen/idle poll契約の範囲で復旧する。
- WebUI/private bearer/protocol/readiness/generationを確認し、本文はpull/HWM0でそのまま転送。圧縮・不適合protocol・SSEでない200を拒否する。接続/headersは10秒、undici bodyTimeoutは0で長時間SSEを切らない。HTTP切断・取消し・upstream EOFはreader/購読/タイマーへ伝播し、エージェントや受理済み処理は停止しない。
- Backendは最大32購読、各Roomのmember/linked Task購読は128まで。1frame/1consumer queueは8MiB、全encoded queueと全保持snapshotはそれぞれ16MiBまで。JSON escaping・key・UTF-8・300,000 nodeをserialize前に制限し、超過は切断する。encode前に残りbyte予算を確認する。1pullは独立した64KiB以下のコピーで、socket側の最後のsliceが巨大なframe backingを保持しない。
- heartbeatは15秒。未消費queue/native drainは45秒期限。producerの追加通知で停滞期限を延ばさない。超過/切断は冪等cleanupでqueue・Room/Task/routine/dirty購読・heartbeat/poll/stall timer・snapshot参照を解放する。private診断はHTTPへ公開しない。
- Room JSONは添付と同じcanonical FD検証、64KiB読取、8MiB上限、同時2件/reuse buffer16MiBを利用。共有metadata待機も最大64。欠落は404、上限/IO異常は503。大きな既存Room・極端なmember/linked Task数は新しい制限を受ける。FD同一性/mtime検査は原子的snapshotの保証ではない。

### SSE検証

- 有界writer9件、owner6件、relay4件、両route4件、既存Room添付11件、client hub7件、native/file server81件、新private ingress2件、契約/AST4件、Task/Room/SSE実2段HTTP各1件の計131件成功。全suiteは実行していない。
- Backend型チェックとWeb source型チェック成功。通常Web型チェックはWebUI再起動で生成された既存Next route型エラー（optional request/defaultModelDir）で失敗。今回のsource型エラーは修正し、生成型を除いた全Web sourceで確認した。既存routeや生成cacheは変更していない。
- 本物のBackend runtime/native HTTPと、別プロセスにbundleした実Next relay/Node HTTP adapterで65秒の継続SSE・4回以上のheartbeat、32消費取消し、Room変更・再接続・両process再起動を検証。停滞clientは接続activeを確認してからpauseし、8MiB queue超過でowner購読を解放。切断後もfixture producerは継続した。
- 最終試験は65,003ms、SSE本文68,930,073bytes。ピーク増分RSSはBackend13,656,064 / relay9,572,352bytes、heap17,941,280 / 463,288、external9,622,055 / 8,356,101。停滞queue peak8,334,121bytes、上限超過切断1回。
- 最後のactive/subscriptions/poll/pendingRead/保持snapshot/writer/queue/heartbeat/stall/metadata active/待機/routine listener/relay activeは0。全queue peakは16MiB以内。RSS128MiB・heap48MiB・external96MiBの従来閾値を維持した有限の試験。Next production server全体や無期限接続の保証ではない。
- Task1GiB/61切断、Room256MiB/32切断+24metadata取消しも再検証し、配信/FD/待機/中継activeは0。
- 原因: 従来NextのRoom snapshot整形/購読を廃止してownerへ移す必要があった。独立レビューではBot一覧からtask_dirtyを落とす互換性欠落を検出し、owner購読を追加してclient hubと再検証した。初期fixtureの停滞判定は接続前の古いactive=0を見ていたため、接続1の採取後にpauseを判定する形へ修正した。

## 残り

message-image、profile export、TTS binary、Task/Bot個別SSE・Provider SSE。既存のProvider SSE中継もPhase4の共通切断・再接続・長時間/停滞検証の対象にする。全対象の所有権と長時間SSEの有界性が確認できるまでPhase4の受入完了とはしない。
