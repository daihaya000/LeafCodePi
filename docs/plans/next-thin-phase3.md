# Phase3: JSON業務APIの移管

## 進捗・範囲

Phase3全体は未完了。Phase0のBackend/Phase3/JSON分類は118経路・182操作。Git・Diff・コミット文生成13経路・14操作と、定義管理14経路・25操作の合計27経路・39操作の境界を移管した。残る91経路・143操作には既存Backend中継も含まれ、受入条件の確認・残存業務処理の移管が必要。

以下は第1区切り（Git・Diff・コミット文生成）の記録。第2区切りの定義管理は末尾に記載する。

| 経路 | 操作 |
| --- | --- |
| git/branches・log・repositories・show | GET |
| git/commit・commit-message・init・merge・pull・push・rm | POST |
| git/pr | GET・POST |
| diff/files | GET |

## 実行境界

- Nextの対象ハンドラーは `relayJsonBusiness(req, route)` のみ。入力の業務解釈、パス認可、Git/gh実行、ファイル更新、モデル選択・推論・生成キャッシュはBackendの `backend/runtime-src/json-business/handlers/` が所有する。
- 依存閉包のGit・diff parser・commit suggestion・ETag helperの4実装をBackendへ移動し、Webの互換exportを維持した。Backendのビルド入力はWebのソース・パッケージに依存しない。
- `shared/json-business-contract.mjs` は経路/メソッド、上限、公開応答の純粋な契約。FS・SDK・秘密情報・singletonを持たない。
- Nextは認証、Origin/CSRF、世代確認、本文の実バイト数上限のみ実施する。内部Bearer/protocolで `/internal/json-business/<route>` を呼び、ブラウザーのBearer/Cookieは渡さない。Backendは起動/maintenance拒否と認可済みcontextを検証し、変更要求のOriginを再検証する。
- 本文は1 MiB、応答は32 MiBの上限。Gitの既存30秒/4 Mi文字/同時8 capture、ghの既存60秒/16 Mi文字、commit-messageの文字数制限を維持する。
- ディレクトリ・実パス・pathspec・branch/hash・Git引数の検証はBackend。PR確認GETも許可されないディレクトリではgh起動前に拒否する。

## 応答・切断

- 内部応答envelopeで公開status/DTO/ETag/Cache-Controlを運ぶ。Nextで304の空本文、Gitエラー、merge成功後の復帰失敗など既存の部分成功フィールドを再構成する。ownerの任意ヘッダー/公開外のトップレベルフィールドやモデル資格情報は転送しない。
- Backend不在・世代不一致・入口拒否では変更処理を `execution:not-started` とする。送信後の応答喪失・不正な応答は `execution:unknown`。ローカル実行へのフォールバックも自動再送もない。
- 設定のPhase2 ledgerとは異なり、Git操作の永続受付IDや結果照会は実装していない。結果不明の変更は実際のindex/履歴/remote状態を確認してから利用者が判断する。
- 読取の切断はBackendに伝播し、Git capture・gh確認・直接推論を中止する。受付済みの変更はクライアント切断だけではkillしない。Git/PR変更途中の安全なrollbackや原子性を追加したものではない。
- 直接推論失敗時の決定的suggestion fallbackはBackendで維持。provider例外本文を警告/ログに公開しない。

## 検証

- ASTで13経路・14操作が単一の中継returnだけであることを検証。共通契約の純粋性と公開DTO投影も検証。
- Next中継の無書込・本文未解釈・認証/CSRF/実バイト上限・秘密非転送・304/Cache-Control・部分成功・応答喪失/不正応答・切断を検証。
- Backend transportの内部認証/protocol、readiness、メソッド、trusted context、本文上限、例外秘匿、切断の読取/変更区別を検証。
- Webなしの隔離fixtureでBackendをビルド・実起動し、Git init/選択commit/log/branches/show/diff/決定的commit-message、304、危険branch/禁止directory拒否を実行。実プロセス再起動後の同じcommit hashを確認した。
- Git/diff/関連helper/Next中継の対象回帰97件成功。Backend transport・AST境界18件成功。独立プロセスfixture成功。Backend/Web型チェックとBackend強制ビルド（6,761 KiB）成功。API ownershipは165経路・258操作のまま。

### 全体回帰

- 初回Web/lib/API全体: 4,996件中4,962成功・32失敗・2 skip。既知30件はPhase2と同名。追加2件は変更外のAnthropic refresh lockで、該当ファイルの単独再実行は8/8成功。
- Backend/Core/関連build・mirror・境界: 1,409件中1,403成功・失敗2・timeout cancel 4。lease・diagnostics・MCP設定/認証・CLI起動の該当6件はconcurrency=1で6/6成功（34秒）。
- 最終Web/lib/API（Backendと同時実行せずworkers=4）: 4,996件中4,964成功・既知30失敗・2 skip。Phase2の失敗名と完全一致し、新規失敗なし。全体スイートが全件成功したとは扱わない。

稼働中のユーザー設定・Gitリポジトリ・サービスは検証用に変更/再起動していない。OS/remoteへの破壊的Git操作は行わず、実Git検証は隔離fixture内で実施した。

## 第2区切り: 定義管理（14経路・25操作）

- `agents` GET/POST、`agents/[name]` GET/PATCH/DELETE、`skills` GET/POST、`skills/[name]` PATCH、`extensions` GET、`extensions/[name]` PATCH。
- `agents-md`・`bots-md`・`soul-md`・`user-md`・`tools-md`・`design-md`・`workflow-md` GET/PATCH、`prompts/transfer` POST。
- 対象Nextハンドラーは中継returnだけ。動的パラメーターのURLエンコードは入口で、名前はBackend入口だけで1回URIデコードし、権限・ファイル操作・SDK反映はBackendで実施する。二重エスケープされた名前を再解釈しない回帰も追加した。Prompt転送のloopback/WebUIアクセスゲート、厳密なOrigin、20 MiB+4 KiBのrequest上限と回復ジャーナルを維持する。
- Agent/Skill/共通Markdownの共通writerにもNext拒否と変更観測を追加。Agent作成のmkdir、override/Skill更新のlock作成、削除も保存境界で保護する。Prompt transfer/formatの2実装をBackendへ移動し、Web互換exportを維持した。
- Phase2と定義管理は `configuration/commands.ts` の同じowner queue/ledgerを利用する。保存をcheckpointしてからBackendがlive reload/agent refreshを行い、applied/deferred/failed/not-requiredを明示する。fire-and-forgetの成功扱いは撤去した。忙しいセッションの反映保留は既存harnessのdeferred経路を使い、実行を中断しない。
- 保存成功・反映失敗は503でも `mutation.saved:true`・complete・保存revisionを維持。複合変更の一部失敗はpartial、同じoperationIdは再起動後も409で再実行を拒否する。結果は既存の `GET /api/settings?operationId=<id>` から読める。NextはACKのoperationIdを照合し、不正/喪失応答をunknownとして扱う。
- Agent編集GETの既存 `{draft,filePath}`、Markdown内容、Code/Bot別Skill設定、default Agent/必須Extension制約を維持する。公開外フィールド、reloadの例外本文、privateな復旧pathを応答に出さない。

### 第2区切りの検証結果

- 定義/関連helper・中継・Phase2設定回帰: 168/168成功。
- Core command・transport・AST ownership・Phase2境界・API inventory: 69/69成功。対象27経路・39操作が中継のみであることをASTで検証。
- Backend/Web typecheck成功。Backend強制ビルド6,820 KiB成功。Web typecheckの初回30秒timeoutとportable Request型の不一致を確認し、Backend transfer-accessの明示参照へ修正して再実行成功。
- Webなしの実Backend fixtureでMarkdown/Agent保存と読込、危険な名前の拒否、実プロセス再起動後の内容・同一receipt読込・重複受付拒否を検証（最終7.7秒）。稼働中ユーザーの定義・SOUL.md・サービスは変更していない。
- 全体Web/Backendスイートは第2区切りでは再実行していない。第1区切りの全体回帰集計を今回の全体通過として流用しない。
