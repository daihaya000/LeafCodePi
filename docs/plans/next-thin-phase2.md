# Phase2: 設定の保存・反映の集約

## 境界

- Phase0でPhase2に分類した16経路・35操作をBackendへ移管。`profile` GET、TTS voices、モデルカタログ、音声生成など後続フェーズの操作は変更しない。
- Nextの対象操作は `web/src/lib/configuration-relay.ts` への中継のみ。認証・Origin/CSRF・実バイト数上限・世代確認を入口で実施する。開発時もローカル保存へフォールバックしない。
- Backendの内部Bearer/protocol認証と起動・更新中の拒否を維持。ブラウザーのBearer/Cookieは内部リクエストへ転送せず、検証済みの認可結果を信頼済みtransport contextとして渡す。
- 保存・業務検証は `backend/runtime-src/configuration/handlers/`。追加のライブラリ依存閉包25実装をBackendへ配置し、Webの既存importは互換入口として維持する。Webのremote `runtime-settings` とBackendのlocal adapterは別実装。
- `shared/configuration-contract.mjs` は通信契約だけ。FS・SDK・秘密情報・singletonを持たない。

## 保存・反映結果

変更操作は従来のDTOに `mutation` を追加する。

| フィールド | 意味 |
| --- | --- |
| `operationId` | 受付操作の識別子。自動再送しない |
| `saved` | 何らかの永続変更を確認したらtrue、変更なしならfalse、判定不能ならnull |
| `saveStatus` | complete: 保存処理を正常終了、partial: 一部または全部の変更後に処理が失敗、none: 変更なし、unknown: 不明 |
| `revision` | 保存を記録したopaque UUID。内容hashやCAS番号ではなく、当該設定コマンドの保存revision |
| `apply` | applied / deferred / not-required / failed / unknown |
| `recovery` | none / restored / required / unknown |

- 保存後に反映が失敗すると503でも `saved:true`・`saveStatus:complete`・保存revisionを保持する。反映保留をappliedと偽らない。
- 書込後の処理失敗はpartial、復旧成功と復旧不能は区別する。SDK資格情報の変更は別途記録し、成功確認できない場合はunknownとする。
- HTTP応答を失ったNextは `saved:null` を返す。保存していないと断言せず、ローカル保存・自動再送もしない。
- `GET /api/settings?operationId=<id>` で直近128操作の結果を再読込できる。結果未記録・プロセス終了中の操作は不明であり、404を未保存の証明として扱わない。
- Backendの `configuration-command.json` は値・秘密・パスを保存しない。書込と反映を同じowner queueで直列化し、通常のライブ反映前に保存revisionをcheckpointする。既存SDK setter内の反映失敗も観測して部分成功として返す。
- 同じoperationIdの再受付は409で拒否する。履歴の永続性は通常のプロセス再起動で検証。OS/電源障害に対するトランザクションや全外部ファイル編集の監査を保証するものではない。

## Profile・安全

- Profile変更はBackendで実行。稼働中セッション・GoalLoop・他のBackendリクエストを拒否し、HTTPとSDKのmaintenance gateを保持する。
- Native MCP有効時のProfile置換・復元・resetは既存のowner `runConfigWrite` を通し、bindingのretire/republishを迂回しない。
- 既存のarchive/展開/ファイル数上限、保全ジャーナル、legacy認証除外、Pushover/TTSの認可条件を維持する。
- 例外本文を内部transportから公開しない。保全ファイルはrecoveryId、Profile backupはファイル名で返す。
- Nextのプロセスroleを明示し、共通設定writerはNextからの書込を拒否する。

## 検証

- Backend/Coreの保存・revision・反映失敗・保留・復旧・重複受付・ledger障害テスト。
- Next中継の無書込、未設定Backend、応答消失、認証/CSRF/サイズ制限、ブラウザー秘密情報の非転送テスト。
- 実際のowner dispatcherで、Code権限の保存成功/反映失敗、intercomの反映保留、Profile maintenance拒否を検証。
- Webを含まないfixtureでBackendを独立ビルド・起動し、設定を保存。実プロセス再起動後に値と同じoperation/revisionを再読込する。
- AST境界テストで16経路の35操作にローカル業務writerがないことを検証。API ownershipは165経路・258操作のまま。
- Backend/Web型チェック、Backend強制ビルドを実施。検証に稼働中のユーザー設定・サービスの再起動は使用しない。

### 最終結果

- Web/lib/API: 4,989件中4,957成功・30失敗・2 skip。失敗名はPhase1で移行前ソースから再現した既知30件と完全一致し、新規失敗なし。
- Backend/Core/関連build・mirror・境界: 1,391件中1,390成功・失敗0・CLI readiness 1件timeout。該当テストの単独再実行は1/1成功（2.2秒）。高並列の初回実行では起動/lease関連のtimeoutも観測し、再実行はconcurrency=4へ制限した。
- Backend/Web typecheck、強制Backend build（6,701 KiB）、API ownership coverage成功。
- 独立fixtureの保存・実プロセス再起動・同一revision/operation読込成功。対象API business回帰、無書込・反映失敗・保留・復旧・境界テスト成功。

稼働中ユーザーサービスの再起動やUI変更は行っていない。設定の保存・再読込・再起動は隔離fixtureで検証した。
