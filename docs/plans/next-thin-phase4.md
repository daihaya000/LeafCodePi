# Phase4 — ファイル配信・ストリーム移管

## 最終状態

**Phase4完了（末尾の有限な受入範囲）**。Phase0掲載14経路・15操作と互換HEAD7操作をBackend所有にした。ファイル解決・権限・読取・生成・購読はBackend、Nextはopaqueな有界中継。対象別負荷試験と実Next production API adapterの大容量・125秒接続試験で、配信資源の解放とメモリ閾値を確認した。以下の追加単位は移管時点の履歴で、当時の未完・未測定記載を保持する。

## 初回単位: Taskローカル画像・動画・音声

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

## 追加単位: Task message-image

- `tasks/[id]/message-image` GETと互換HEADを共通file-streamへ移管。累計9経路・Phase0掲載10操作（互換HEAD追加6操作）。Nextはopaque中継のみで、Task detail全JSONの取得・SDK読取・画像選択・base64全体復号を廃止した。
- BackendでTask登録、messageId/partId（trim後512文字以下）、現在branchへの所属、実UIのentry row ID/msg-N-image-index、user/表示custom画像を検証する。compaction前の履歴とhidden context markerもordinalへ反映する。別branch、stripped画像、assistantの未投影画像を漏らさない。
- owned liveは既存private `__leafcodePiHarness.live` のindexed SessionManager getLeafId/getEntryだけを読む。getBranchの全コピー、ensureLive、SDK/session hydration・投影image cacheは使わない。live rewindの未永続leafを優先し、例外時に別branch/coldへfallbackしない。archived/foreign/coldは登録sessionFileの同一canonical FDからreadonlyで読む。
- coldはv3 JSONLのみ（legacyは409、移行・session rewrite・slimmingなし）。FD dev/ino・size/mtimeNs/ctimeNsとcanonical名を開始/終了で検証し、変更時409。原子的snapshotは保証しない。最大512MiB file、16MiB/line、100,000 entryかつ推定index8MiB、8秒scan期限。大きすぎる既存履歴は413/503になる制約がある。
- scan/readは64KiB刻み、1reader/最大32待機、16MiB reuse buffer。取消しでFD/待機/枠を解放する。FD世代とoffset/ancestryだけを最大4件/合計推定8MiB cacheし、本文・base64・SDK objectはcacheしない。安定世代の再要求では対象行だけ読み、same-size rewrite・inode交換・追記は世代を無効化する。
- 画像は新しく8MiB以下、canonical base64/末尾padding bit/登録raster MIME・署名を照合（SVG等は415）。全保持base64は32MiBまで。1pull最大64KiBだけ復号、内部3byte alignmentのdecode最大65,538bytes。全画像復号やNext全体bufferはない。private no-store/inline/nosniff/same-origin、Range206/416・suffix・If-Range全体200・HEADを共通実装で維持する。
- 関連Web43件、native/file server+契約/AST91件、実message-image2段HTTP1件の計135件成功。Backend/Web source型チェック成功。通常Web全体は前単位同様、生成済みNext型の既存エラーを含むためsource専用configで検証した。全suite・Next production全体は未測定。
- 約72MiBの隔離履歴（compactionを含む）から2MiB画像を4並列×32巡、計256MiB配信。32本文切断、24scan/待機取消し、Range/HEAD/auth、画像branch変更、Backend/relay再起動後のbranch拒否と復元を確認。session SHA256は読取の前後で不変。実モデル/ユーザーデータ/ユーザーサービスは操作していない。
- 最終active/添付FD/image reader/待機/image FD/保持image/保持base64/relay activeは0。意図的な16MiB scan bufferと20,390bytes metadata indexは有界で残す。最終測定RSS増分はBackend16,232,448 / relay21,962,752bytes、heap6,861,664 / 1,995,952、external13,633,593 / 18,279,899。閾値RSS128MiB/heap48MiB/external96MiBを維持。
- 原因: 初版は毎回全行をJSON解析し、反復配信でheap増分66,440,184bytes（48MiB超）、RSS105,250,816bytesになった。image dataではなく世代検証済みoffset/branch metadataだけを有界cacheし、対象行のみの再読込で閾値を緩めず再検証した。

## 追加単位: profile export・backup一覧

- `profile` GET/gzip、`?backups` GET/JSON、互換HEADを共通file-streamへ移管。累計10経路・Phase0掲載11操作（追加HEAD7操作）。Nextはquery/Range/Originをopaque中継し、profile lib/FS/SDK・全archive bufferを持たない。POST/PATCH/PUT/DELETEの設定mutation契約は変更しない。
- Backendの既存portable policyを共用し、v1 gzip JSONのformat/version/createdAt/files(base64)/modesを維持する。auth.json・accounts等の既存除外対象を維持。Unicode名/内容、空file、3byte境界、mode、旧exportとの同一files/modes、再起動後のexportを確認した。
- gzipは生成型でサイズ/validatorが未確定のため、Range・If-Rangeは全体200、Accept-Ranges:none、Content-Lengthなし。部分gzip/206/再開は提供しない。HEADはinventoryと同じヘッダーだけ返し、内容読取/圧縮なし。private no-store/attachment/nosniff/same-origin、既存transferのloopbackまたはaccess gate・Origin検証を維持した。
- 元内容240MiB/50,000fileは従来上限を保持。展開JSON384MiB/gzip256MiBは既存import上限にも合わせる。inventoryは推定8MiB/stream、depth32、key4096文字、8秒、全生成120秒の追加制約。directoryをopendirで逐次走査し、canonical rootを要求、symlink/junctionを辿らず、FD dev/ino/size/mtimeNs/ctimeNsとnamed pathを開始/終了で検証する。原子的directory snapshotは保証しない。制限超過/IO/変更はヘッダー前413/403/503、本文開始後はstream failureで不完全archiveを成功扱いしない。
- 共有32配信枠の内側にprofile最大2枠（待機なし）。1resource FDずつ、48KiB入力→最大64KiB base64入力、gzip chunk64KiBとbounded pipeline、Web HWM0で配信。spool/一時archive/全内容JSON/gzipSyncを使わない。切断でgenerator/FD/opendir/gzip/pipeline/admission/metadataを解放する。Native45秒drain timeoutも維持。
- backup一覧はownerで最大512件/512文字name、応答JSON64KiB以内に制限し、mtime順/name/createdAtだけ返す。新規のbackups副作用や読取によるbackup生成はない。
- 原因: 旧GETはNextで全ファイルbase64・全JSON・gzipSync・archiveの複数copyを作っていた。新しいexport専用generator/pipelineへ分離し、既存mutation backup/rollback用sync exportは今回の配信経路で使わない。
- 関連Web85件、native/server・configuration/file AST109件、実2段HTTP1件の計195件成功。Backend/Web source型チェック成功。途中のWeb source tscは別セッションのStringIterator test型エラーで失敗したが、その修正後に全sourceを再検証して成功。全suite/Next productionは未測定。
- 隔離64MiB incompressible resourceを2並列×4巡、元内容512MiB、gzip539,146,296bytes転送。32本文切断・16inventory取消し後、active/FD/directory/compressor/metadata/relayは全0。source SHA256不変、Range全体200/HEAD/auth/Origin、両プロセス再起動後のv1 export・backup一覧を確認。実モデル・ユーザーデータ・ユーザーサービス操作はなし。
- 最大RSS増分Backend58,716,160 / relay22,216,704bytes、heap30,171,408 / 6,099,048、external38,948,100 / 13,774,216。RSS128MiB/heap48MiB/external96MiBの閾値は維持した。SSE/無期限接続・実Next productionの受入は残る。

## 追加単位: TTS binary

- `tts/synthesize` POSTを共通file-streamへ移管。累計11経路・Phase0掲載12操作（追加HEAD7操作）。Nextは最大16KiB/2秒のopaque入力だけをbufferし、音声をpull/HWM0で中継する。JSON/base64音声envelopeと90MiB例外を削除、voicesはJSON APIに残す。非HTTP向けの従来buffered合成helperは互換維持。
- Backendは既存のtext上限2000文字、Bot voice、設定URL、unauthenticated URL、Origin/auth/readiness/generationを保持。Voicevox/AivisSpeechのquery→synthesisとraw/OpenAI互換bodyをそのまま使い、engine responseを音声streamにする。共有32枠内に最大2合成、音声64MiB、受信chunk最大256KiB、出力64KiB view/HWM0。各engine requestは従来の60秒期限、Nextのheader期限150秒、native45秒drain期限を維持する。
- 生成型なのでRange/If-Rangeは全体200、Accept-Ranges:none、Content-Lengthなし。最後のbyteまで読んだ後の永続receipt更新成功を確認してclean EOFを返す。超過・途中取消し・短いdeclared-length・checkpoint失敗はstream error/unknown。operation UUIDとunknown headerを確認し、private/protocol/set-cookieは転送しない。
- 同じIDの受付を拒否するID-onlyの128件ledger（旧version1互換、0600 temp/atomic rename/file lock）。unknownをevictせず、completeの古い行のみevictする。128件全unknown・破損・256KiB超ledgerは503で停止する。先にunknownを保存してからengineを呼び、再起動後も同じIDを409にする。履歴evict後の永久重複防止・電源断耐久は保証しない。
- 受付後のheader待ちはconsumer signalでengine POSTを中断しない。取得後の音声読取は切断で取消し、reader/held chunk/枠を解放する。engine側がsocket切断を計算停止として扱う可能性は制御できないため、切断やengine失敗はunknownとして保存し自動再実行しない。errorは有界の一般化された応答で、音声やtext/URL/Bot情報をledgerへ保存しない。
- 関連Web134件、native/server/契約/AST219件、実2段HTTP1件の計354件成功。Backend/Web全source型チェック成功。隔離fake engine＋実Backend＋bundleした実Next relay/Node HTTP adapterで64MiBを2並列×4巡、計512MiB配信。32本文取消し、受付済header待ち取消し1件、Range無視、raw body、両process再起動後のcomplete/unknown ID拒否を実証。終了時active/FD/reader/held chunk/relay/engine接続は0。実モデル・ユーザーデータ・ユーザーサービスを操作しない。
- 最終RSS増分Backend92,790,784 / relay51,273,728bytes、heap8,310,264 / 2,980,272、external90,766,011 / 44,427,649。RSS128MiB/heap48MiB/external96MiBの閾値を維持。有限の2段HTTP試験で、Next production全体・全suite・無期限の証明ではない。
- 原因: Nextのrequest body変数を同scopeのresponse body宣言がshadowし、fetch前のTDZで503になった。変数を分離してPOST/既存file中継を再検証した。追加copy版はBackend external増分102,164,057bytesで96MiBに抵触し、受信最大256KiBを保持した64KiB viewへ変更して閾値を緩めず再測定した。reviewでreceiptの全量readもbounded FD readへ修正した。

## 追加単位: Task/Bot個別SSE

- `tasks/[id]/events` と `bots/[id]/events` GETを共通live-eventsへ移管。累計13経路・Phase0掲載14操作（追加HEAD7操作）。Nextはquery/Last-Event-IDとbytesだけを中継し、詳細poll・履歴比較・SDK subscription・Bot inbox読取を持たない。auth/private protocol/readiness/generation/32枠、undici bodyTimeout=0、native drain45秒を共用する。
- 既存owner側のbootstrap/ready/cache_ready/messagesReused/historyReset、permission/question・abort/hang/Goal/todos/sessionResume、delta/streamDeltas/streamMessages/perf、foreign lease poll/backoffとmessage deltaを維持。ready待ちのcontrol保持・resolved pair・古いhistory除去の純粋helperをBackendに配置した。Bot inboxはowner subscriptionに加え2秒のread-only safety pollで他process更新も取得する。
- 詳細取得は既存BackendのreadOnly経路を指定し、閲覧でensureLive/モデル生成を開始しない。共有詳細取得2件・待機32件、待機中切断はSDK read前に取消す。受付済readonly getterそのものはSDK APIの期限/完了に従い、SSE切断でTaskや生成処理をabortしない。cold SDK transcriptの解析・cacheは既存ownerの実装で、巨大cold transcriptの追加ストレス計測は今回の試験に含めていない。
- frame/stream queue8MiB・全SSE queue16MiB、ready待機64件/8MiB・全個別ready buffer16MiB。JSONを事前見積りし、over-limitは閉じて次回のfull snapshotを要求する。64KiB出力/HWM0、15秒heartbeat、45秒stall。差分判定のfield cacheは各16,384文字、foreign page cacheは131,072文字まで。巨大summaryで過去の小さなcacheが残り、元に戻した変更を誤ってreuseする問題もreviewで修正した。
- Last-Event-IDでイベントlogをreplayしない。再接続・Backend/relay再起動は最新bootstrap/readyの再取得でhistory/controlを復元する。接続終了時にsubscription・ready buffer・queue・poll/heartbeat/stall timerを解放する。未知Taskはownerで404。read-only受付やstream closeをTask commandとして再実行しない。
- 関連Web75件、native/server/契約/AST89件、実2段HTTP1件の計165件成功。Backend/Web全source型チェック成功。隔離v3 transcript＋実Backend＋実Next relay/Node HTTP adapterを使い、Task/Bot同時65,010ms・138,550,875bytes、32切断、停滞socketのqueue overflow終了、producer継続、再接続・両process再起動後のTask/Bot readyを実証。session SHA256不変、active/subscription/reader/waiter/pending buffer/poll/heartbeat/stall/relayは終了時0。実モデル・ユーザーデータ・ユーザーサービスを操作しない。
- 最終RSS増分Backend58,744,832 / relay11,325,440bytes、heap31,087,664 / 583,864、external7,500,248 / 8,432,228。queue peak8,343,011bytes、global16MiB以下。RSS128MiB/heap48MiB/external96MiBの閾値を維持。有限のSDK snapshot＋イベントbus試験で、実モデル生成中・巨大cold履歴・Next production・無期限の証明ではない。
- 原因: 旧NextはBackend詳細のpoll・前回page/serialized fields・Bot共有mailboxを所有し、配信と業務snapshotが混在していた。ownerの既存local SSE契約を移し、有界writerとready bufferへ接続した。初期fixtureのBot taskをstoreへ登録せずreadyが空になった点、readOnly flag/小frame分割/dedup後の再構成が旧mock期待値と異なった点を修正し再検証した。

## 追加単位: ProviderログインSSE

- `providers/[id]/login/events` GETの既存Backend所有権を維持し、Phase4の有界配信・切断・再接続契約へ統合。累計14経路・Phase0掲載15操作（追加HEAD7操作）の配信経路がBackend所有になった。Nextは認証セッション・SDK・FSを持たず、private bearer/protocol/readiness/generationの確認後にopaque query/bytesだけをpull/HWM0で中継する。redirect/error、identity encoding、protocol一致・非圧縮SSE200を必須にし、privateヘッダーを転送しない。接続/header期限10秒、undici bodyTimeout=0。RangeはSSEに適用せず全体200。
- Backendは最大32stream/32session購読、frame64KiB、consumer queue1MiB、全Provider encoded queue16MiB。serialize前にUTF-8/escaping/complexityを見積り、overflowはその購読だけを閉じる。15秒heartbeat、未消費queue/native drain45秒。producer通知では停滞期限を延ばさない。正常done/replayは残るframeをdrainしてからEOF、abort/overflowは即時drop。同期replay中のdone/overflowでも返されたunsubscribeを解放する。
- 元のログインhistory配列はnotify数に比例して増えた。現在はpublic projectionだけをtype別最大7件、各encoded event64KiB未満・合計512KiB未満にcoalesceする。最新auth URL/device code/info/progressと現在のprompt/started/doneを残し、回答・abort後のpromptは消す。pending promptも128options/64KiB、OAuth callback対象を解析するURLも32,768文字で制限。巨大/不正notifyはsafe infoへ置換し、原credential/errorを保持・配信しない。数字はencoded予算でありJS stringのheap byte数そのものではない。
- 接続切断では受理済みログインをcancel/retryしない。同じsessionIdの再接続は最新state・未回答prompt・有効callback URLを復元し、回答済prompt/提出済callbackを復活させない。Last-Event-IDのevent log replayは提供しない。認証完了後は安全なdoneをreplayし、subscriptionは再登録しない。Backend再起動でin-memory login sessionは失われ、旧sessionIdはsafe done(false)で閉じる。認証commandのdurable receiptによる重複拒否は既存のまま。再起動でOAuth処理や入力を自動再実行・永続復元する保証はない。
- Native reader/drain waiterは必ずfinallyでcancel/releaseし、preabort・不適合source・owner応答待ち中の切断もbodyを解放する。closeとAbortSignalが同時に発火してもwaiter減算は一度だけ。カウンタはprivate実装exportで、public HTTPには公開しない。
- 関連Web66件、native/server/auth ledger/contract92件、実2段HTTP1件の計159件成功。独立reviewでAPI所有権/Backend build/Webなし起動の15件も実行し、合計174件成功。両source型チェック成功。SDK認証本体は隔離fake interactionだが、実Backend owner/harness/native server＋実Next relay/Node HTTP adapterを独立processで実行。実credential/provider network、ユーザーデータ・ユーザーサービスは操作していない。Next production server全体・実OAuth/無期限接続の計測ではない。
- 実試験125,009ms・529,769,380bytes、同時2stream・各8heartbeat、32consumer cuts、paused socketのqueue overflow、producer継続、再接続による未回答prompt/callback復旧、同じownerの認証完了/done replayを確認。両process再起動後に旧sessionIdを拒否し、新sessionを取得。終了時active/subscription/reader/drain waiter/queue/heartbeat/stall/listener/relayは全0。意図的なbounded回復historyは4件/33,078encoded bytes。queue peak1,016,645bytes。
- 最終RSS増分Backend29,945,856 / relay13,500,416bytes、heap33,213,152 / 351,648、external4,243,977 / 8,945,301。RSS128MiB/heap48MiB/external96MiBの閾値を維持。序盤/終盤windowの最低heap差はBackend-28,224 / relay137,536bytes（保持heap増分8MiB未満）。20,000notify後のhistory/prompt回復、未消費global queue、32枠、短縮stall、preabort/重複close、safe projectionもunit testで確認した。
- 独立reviewでPhase4の既存検証に2件の追随漏れを発見。所有権JSON/Markdownへ互換HEAD7件を登録し、Phase0の歴史的258操作を保持した上で現在の165route/265operationを検証。Webなし独立起動fixtureのTTSを旧JSON/base64からraw binary ingressへ更新し、廃止JSONの404・音声bytes/operation ACK・voice選択・失敗/再起動後のcomplete/unknown重複拒否を再検証した。最終Backend build7,708KiB、15件全成功。実装を旧JSONへ戻したり、検証を削除・skipしたりしていない。
- 原因: 旧SDK historyの無制限配列、readers数の上限欠如、未消費heartbeat、Nextのglobal fetch/既定prefetchとprotocol未検証、native preabort時のlock解放漏れ。state coalescing・有界queue・専用dispatcher・無条件finallyへ変更した。初回125秒fixtureは16KiB×5msを仮定した配信量assertを満たさなかった。32,700文字へ増やした最終試験の実測8,077notify/125秒（約15.5ms周期）では各264,884,690bytes、errorなしで通過。メモリ閾値は緩めていない。Vitestを誤ってrepo cwdで起動したalias解決失敗もWeb cwdで再実行した。

## 追加単位: 巨大cold履歴SSE・実Next production

- 原因: 個別SSEのページ化はSDKの全履歴open/branch projection後だった。従来のSDK load guard/cache上限だけでは、SSEに必要な最新ページの読取・解析・取消しを独立に制限しなかった。SDK SessionManagerのopen/repairへ入らないSSE専用readonly adapterを追加した。既存owned live snapshotはそのままで、cold/archived/foreign-ownerだけを対象にする。JSON業務APIのgetter・SDK load guardは変更していない。
- Backendの同じcanonical FDから64KiBずつv3 JSONLをscanし、現在branchのoffset/IDだけを索引化する。special file/末端・親symlink、FD/名前のdev/ino差替え、読取前後のsize/mtimeNs/ctimeNs変更、不正UTF-8/cycle/欠損parentを拒否する。legacyの移行・repair・ファイル書換えはしない。malformed JSON行はSDKと同様skipするが、索引の連鎖が壊れた場合は拒否する。
- ファイル512MiB、1行2MiB、索引課金8MiB/100,000 entries、LRU4件/合計8MiB、選択raw/throughput/todo/resume読取合計4MiB、projected pageのescaping/UTF-8予算4MiB。同時scan/read1件・待機32件、再利用buffer2MiB・追加scan scratch64KiB、取得後8秒期限。索引予算はJS objectの正確なheap量ではない。大きな既存行/画像・user turn・legacyはSSE errorで終了し、無制限のSDK fallbackはしない。message-image binaryの既存8MiB上限を拡張・縮小していない。
- 索引ID/parent/firstKept/sessionIdをUTF-16 round-tripで独立保持し、長いJSON substringが元の巨大行をpinしない。decoded message/pageは索引cacheへ保存しない。待機取消しと実scan途中の切断で枠/FDを解放し、Task/モデル/accepted commandを停止しない。generationが同じ再接続/pollは索引だけを再利用する。Task更新・履歴取得の原子的snapshotは保証しない。
- ページは既存の設定20–1000件とuser turn境界を維持。full branchのglobal raw ordinalによるpart ID、実entry ID、compaction・toolResult merge・agent/Goal Loop/intercom境界、最新todos/resume、page対象のpersisted throughputを復元する。WeakMapのwindow metadataでhasMore/nextCursorを維持し、Nextは引き続きopaque relay。旧JSONのload-more経路は別契約のまま。
- shared SSE writerに64 queued frame上限を追加した。encoded byte予算だけでは多数のtiny frameの配列/Uint8Array object量を制限できないため。8MiB単一frame・8MiB consumer bytes・16MiB global bytes・64KiB chunk・45秒stallは維持し、overflowはsubscriberだけを閉じる。validation時は実文字列のescaping/byte/node予算を検査しながら文字列値を出力へコピーせず、実送信では改めて完全なserialize budgetを適用する。JSONとSSE prefix/suffixを1個のexact-size Uint8ArrayへencodeIntoし、UTF-16全frameの追加flatten/copyを避ける。
- 隔離fixtureで実Backend owner/native HTTPと、dev:falseの本物のNext production request handlerを別processで起動。元のthin API15経路（Phase4の14経路＋既存browse/icon）と実import graph93 moduleを変更せずwebpack production buildした。mock route/relay/Node代替adapterではない。一方、全WebUI page/instrumentation/Proxyを含むアプリ全体のproduction buildではない。Next fixture buildの型検査は省略し、別途Backend/Webの全source型検査を実行する。
- 269,584,138byteのv3履歴（長いID、未選択のsibling branch、最新small page）を実読取。32 SSE cuts、8 uncached scan cuts、16 file cuts、foreign leaseの2秒safety poll、Range206/416/HEAD、再接続、両process再起動後のTask/Bot readyを確認。試験用mtime更新でgenerationを変えるが、transcriptのSHA256/本文は不変。SDK未loadを診断でassertし、ユーザーデータ・ユーザーサービス・実モデルは操作しない。
- 実Nextから128MiB WAVを4回、合計536,870,912bytes配信。Task/Bot同時125,009ms、551,313,481bytes、8回以上のheartbeatを維持。paused socketは64 frame quotaで終了し、producerはsubscriber閉鎖後も継続する。最終active/FD/reader/waiter/subscription/queue bytes/queue frames/poll/heartbeat/stall/Next activeは0。意図的cacheは索引1,989,526課金bytes/1件とbuffer2MiBだけ。
- 最終peak増分RSS Backend97,370,112 / Next69,996,544bytes、heap37,111,784 / 13,244,616、external62,720,324 / 55,473,548。序盤/終盤windowの最低heap差390,688 / 98,224bytes。RSS128MiB/heap48MiB/external96MiB・steady heap8MiBの閾値は維持。baseline heap45,501,256 / 32,038,312bytes、Backend最大heap82,613,040bytesのphaseはcold再scan。GC/起動時点に依存する差分値で、固定のheap使用量・無期限・実モデル生成中の保証ではない。
- 初期のproduction試験はBackend heap増分59,043,904、再試験60,758,424bytesで48MiB閾値に抵触した。不要なvalidation JSON文字列/全SSE文字列copyを削除し、decoder再利用・ID backing分離・frame数上限を加え、閾値を緩めず最終試験を通した。GC/baselineも変動するため個別変更だけの因果効果とは断定しない。fixtureのprivate ingress option名の誤りによる503と、型検査を同じshellで待ち30秒timeoutがbackgroundも終了させた点も修正した。

- 独立reviewでin-flightの旧ファイル読取後にTask metadataを再取得すると、新session IDで旧履歴をlabelし得る点を修正。読取開始時のTask rowと結果を組にし、session切替・不正UTF-8・window外persona/part IDの回帰テストを追加した。関連Web110件、native/protocol/所有権/build/Webなし起動40件、実Next統合1件の合計151件成功。Backend/Web全source型検査はともに成功。全Web test suiteや実provider/model networkは未実行。

## 最終追加単位: 生成profile・TTS・Provider SSEの実Next production

- `generated-production-stream-integration.test.mjs` を追加。前回と同じ実API15経路・実import graph93 moduleのproduction buildを共通 `stream-production-test-support.mjs` へ抽出し、前回cold/file/Task/Bot試験も同じbuilderで再実行した。Nextは実route/relayをfixtureへ差し替えず `dev:false` のrequest handlerで実行し、Backendは実owner/native ingress。file relayのOrigin復元修正もこの実buildへ含めた。fakeにしたのは隔離TTS engineとSDKログインinteractionだけ。
- profileは64MiB resourceを2並列×4巡、raw source計512MiB・gzip配信539,149,312bytes。32本文切断・16取得前取消し、HEAD、Range/If-Rangeを無視する全体200、auth/異Origin拒否、SHA256不変を確認。両process再起動後に小さなv1 archiveを復号し、日本語・base64 bytes・modes・auth.json除外を確認した。大きなarchiveをNext/試験consumerで全体bufferしていない。
- TTSは64MiBを2並列×4巡、536,870,912bytes。32本文切断と受付済header待ち取消し1件、Range無視、private/set-cookie除外、clean EOF・complete/unknown receiptを確認。両process再起動後も同じIDを409にし、再受付でengineを呼ばない。engine計42呼出し・切断33件、最終接続0。実モデル・実credential・ユーザーデータ・ユーザーサービスは操作していない。
- Providerは2接続・125,013ms・535,934,840bytes・各8heartbeat。32切断、paused socketのqueue overflow、producer継続、Last-Event-ID付き再接続で未回答prompt/callback復元、完了/done replay・回答内容非漏洩を確認。両process再起動後に旧sessionのsafe done(false)と新sessionを確認した。最終active/subscription/reader/drain waiter/queue/heartbeat/stall/listener/Next activeは0。意図的回復historyは4件/33,078encoded bytes、queue peak1,016,645bytes。
- profileのFD/directory/compressor/metadata、TTS reader/held chunk/枠、共通file active/FD、engine接続も最終0。50ms間隔でBackend/NextのRSS・heap・externalを採取し、RSS128MiB・heap48MiB・external96MiB、steady heap8MiBの閾値を一切緩めず合格した。

| 最終生成/Provider試験の増分bytes | Backend | 実Next production |
| --- | ---: | ---: |
| peak RSS | 125,308,928 | 108,503,040 |
| peak heapUsed | 32,522,400 | 8,375,416 |
| peak external | 98,846,966 | 89,575,305 |
| 序盤/終盤windowの最低heap差 | 294,800 | -448 |

- 原因: 最初の実Next試験ではsame-Originのprofile HEADが403。fixtureの実待受portをNextへ渡していなかった点に加え、NextURLが127.0.0.1をlocalhostへ正規化するため、従来relayの内部OriginとブラウザOriginが一致しなかった。fixtureを実portで起動し、file relayは有効なHTTP Hostからpublic authorityを復元する。scheme/queryは保持し、実Originを内部へ転送する。Origin自身を信頼してURLを作らず、userinfo/path/query/fragment/複数authority/不正portを含むHostは受付前400。業務bodyやファイル権限をNextで解釈しない。異Origin403・不正Host拒否をunit/実productionで維持した。
- 原因: 統合負荷後のProvider送信中にBackend heap増分65,261,272、再計測65,202,240bytesとなり48MiB閾値へ抵触。回復historyのサイズ計測だけに大きなJSONを作る処理と、SSE文字列の追加結合copyが残っていた。public DTOの実escapingを検査しながらpayload文字列をmaterializeしないencoded JSON byte計測へ変更し、prompt事前検査も非copy化。送信は再利用encoderでprefix/JSON/suffixを1個のexact Uint8Arrayへ符号化する。実serialize・frame/queue制限・安全projectionは削除していない。最終のProvider heap peakは80,849,448bytes、baseline48,327,048bytes。GC/起動条件も変動するため、個別変更だけの因果効果は断定しない。
- 共通writer変更後のcold/file/Task/Bot実production試験も再成功。269,584,138byte transcript、file536,870,912bytes、SSE125,005ms/550,064,919bytes、32SSE切断/8scan切断/16file切断、Range206/416/HEAD、再接続・再起動・SDK未load・SHA不変・資源0を再確認した。peak RSS Backend95,952,896/Next101,208,064、heap34,823,144/20,297,624、external68,154,518/71,609,240bytes、steady heap -160,248/-528bytes。
- この最終単位はWeb131件、native/protocol/ownership/Backend build/Webなし起動122件、実Next production統合2件の**255件成功**。Backend/Web全source型チェック成功。現在のAPI所有権165経路/265操作に欠落・重複・未所有なし。旧AST検査のserialize文字列への依存も新しい計測/検査APIへ追随させ、検査を削除・skipしていない。

## Phase4受入マトリクス

全14経路のowner・拒否・取消し・資源上限をunit/nativeで確認。経路固有の負荷は実owner＋実relay/native HTTP試験、共通file/live/Provider transportは実Next production API fixtureでも確認した。

| 対象（計14経路） | 配信契約・経路固有の証拠 | 実Next productionの証拠 |
| --- | --- | --- |
| Task image/media（2） | Range206/416/HEAD・1GiB・61切断 | 共通file、512MiB・Range/HEAD・16切断 |
| Room files/images（2） | Range/HEAD・256MiB・32切断/24metadata取消し・再起動 | 共通file中継、両routeの実build |
| Project icon/preview image（2） | Range/HEAD・256MiB・64切断・保存icon復旧/preview ID失効 | 共通file中継、両routeの実build |
| Room/Bot-list events（2） | SSE65秒/68,930,073bytes・32切断・再接続/再起動・資源0 | 共通live中継、両routeの実build |
| Task message-image（1） | 72MiB transcript・256MiB配信・32切断/24scan取消し・Range/HEAD・SHA不変 | 共通file中継、routeの実build |
| profile（1） | incremental v1 gzip・生成Rangeなし・FD/metadata/compressor0 | 512MiB source/539,149,312bytes・32切断/16取消し・再起動/v1 |
| TTS synthesize（1） | raw binary・生成Rangeなし・ID-only bounded receipt・受付後自動retryなし | 512MiB・32切断/header待ち取消し・complete/unknown再起動拒否 |
| Task/Bot individual events（2） | fresh bootstrap/ready・readonly cold branch・control・foreign poll | 269,584,138byte履歴・125秒/550,064,919bytes・切断/停滞/再接続/再起動・資源0 |
| Provider login events（1） | bounded current-state復旧・commandとsubscriber取消しの分離 | 125秒/535,934,840bytes・32切断/停滞・prompt/callback/done・再起動・資源0 |

### 合格範囲と残る保証外

- 受入条件「大容量配信・長時間接続でメモリ増大や処理残留がない」は、上記有限な負荷・切断・停止consumer・再接続・再起動条件の**配信層**について合格。ペイロード全量に比例するNext buffer、通知履歴の無制限増大、取消し後のFD/購読/queue/timer残留を持たない。意図的な有界cache・索引・receiptは残す。OS/GC/HTTP bufferを含む実測であり固定64KiBの使用量とは主張しない。
- 無期限・全14経路同時の最大負荷・全WebUI pages/instrumentation/Proxyを含むproduction構成・実provider/model/engineの計算資源・電源断耐久・原子的directory/transcript snapshotは未検証/保証外。実API adapterのfixture buildは型検査を省略するが、別の全source型検査を成功させた。全Web test suiteの既存baseline問題を解消したとは主張しない。
- JSONの古い履歴getter/load-moreは別契約で、既存SDK guard/cacheが残る。今回の512MiB readonly cold SSE readerの証拠を、そのJSON経路の巨大履歴・SDK hydration保証へ流用しない。既存owned live SDK sessionの業務状態増大も配信queueの上限とは別。
- Phase4の移管・受入はここで終了。全WebUI構成やJSON履歴の追加最適化を、この完了のための未定義な追加条件にしない。
