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

## 残り

Room添付file/image、message-image、project icon、profile export、preview image、TTS binary、Task/Bot/Room/Provider SSE。既存のProvider SSE中継もPhase4の共通切断・再接続・長時間/停滞検証の対象にする。全対象の所有権と長時間SSEの有界性が確認できるまでPhase4の受入完了とはしない。
