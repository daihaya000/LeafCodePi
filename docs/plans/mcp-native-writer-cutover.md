# Native MCP writer集約・切替条件

## 状態と範囲

- 調査基準: `e520875b`。tracked sourceの構成writerと呼出経路を棚卸しした。本番設定・資格情報・ACL・プロセスは読み取り／変更していない。
- native loader・coordinator・同期updater・固定ファイルwriter・実権限attestorは準備済み。本番session factory・管理actionへの組込みは未実施。
- この文書は実行承認や停止確認の代わりではない。外部エディタ、他checkout、別CLI、動的な任意コードまでwriter不存在を保証しない。
- 最終形はBackend単一owner。production WebUIはforwardまたは明示拒否で、ローカルfallbackなし。恒久的なadapter/native二重運用はしない。

## 確認したwriter

| 経路 | 保存先・現在の実装 | 集約／停止条件 |
| --- | --- | --- |
| MCP ON/OFF | [Backend entry](../../backend/src/entry.mjs)の`setMcpServerEnabledAction` → runtime export → [mcp.ts](../../web/src/lib/mcp.ts)の`setMcpServerEnabled`。global `mcp.json`へ`disabled`を保存。`atomicWrite`はmkdir→temp→renameでnative coordinator/lockを使わない | native `enabled`への変換だけでは不十分。旧呼出を閉じて同じBackend ownerのsettings更新へ移す |
| preset作成 | [preset admin](../../web/src/lib/mcp-preset-admin.ts) → `addN8nServer` / `addSlackServer` / `addGoogleWorkspaceServers` / `addNotionServer` → 同じ`atomicWrite` | 新server追加・Google client情報・旧auth/transport設定を扱う。settings-only native writerに渡さない。native仕様で別途検証／保存するまで切替不可 |
| bearer save/remove | [save admin](../../web/src/lib/mcp-bearer-admin.ts) / [remove admin](../../web/src/lib/mcp-bearer-remove-admin.ts) → adapter store bridge → `enableMcpBearerStore` / `disableMcpBearerStore` | store変更のawait後にconfig selectorを書き換える。受付停止だけでなく進行中operationも完了／fenceする。storeとconfigのtransaction／rollbackは現状ない |
| headers save/remove | [save admin](../../web/src/lib/mcp-headers-admin.ts) / [remove admin](../../web/src/lib/mcp-auth-remove-admin.ts) → bridge → `enableMcpHeadersStore` / `disableMcpHeadersStore` | bearer同様。旧`headersStore`・`auth:false`をnative設定に黙って残さない。別store削除後の失敗も部分変更として扱う |
| adapter `/mcp enable/disable` | [index](../../extensions/leafcode-mcp-adapter/index.ts) → [config](../../extensions/leafcode-mcp-adapter/config.ts)の`writeProjectServerDisabledOverride` → project Pi config | Web管理APIの停止では止まらない。旧session/commandと子sessionを停止する。native global-only loaderはproject設定を暗黙採用しない |
| adapter setup・direct tools | [commands](../../extensions/leafcode-mcp-adapter/commands.ts) → `ensureCompatibilityImports` / `writeStarterProjectConfig` / `writeSharedServerEntry` / `writeDirectToolsConfig` → `writeRawConfigObject` | global imports、project `.mcp.json`、provenance別sourceへの書込みがある。setup/TUI/quick-addを閉じ、directTools等の非互換を移行前に解決する |
| standalone adapter CLI | [cli.js](../../extensions/leafcode-mcp-adapter/cli.js)の`runInit` → `writePiConfig` → global `mcp.json`へ直接write | Backendのprocess-local coordinatorでは止まらない。CLI利用停止・別プロセスowner排除が必要。token CLIも資格情報writerとして別途対象にする |
| profile import/restore/reset | [profile route](../../web/src/app/api/profile/route.ts) → [profile library](../../web/src/lib/profile.ts)の`importProfileWithBackup` / `restoreProfile` / `resetProfile` → `applyProfile` / `removeConfiguredPaths` | exported filesに`mcp.json`を含む。全体置換・削除・失敗時rollbackもnative lockを使わない。routeにはruntime所有権ガードがないため、production WebUIの別writerとして必ず塞ぐ |
| profile package復元 | 同routeのPATCH `restore-packages` → `restoreProfilePackages` → `pi update --extensions` | MCP本体への直接writeとは区別するが、古いextension/package writerを再導入し得る。切替中の再取得を閉じる。exportはread-only、backup作成はlive configを書かない別操作として区別する |
| migration apply primitive | [migration file](../../backend/core/mcp-config-migration-file.mjs)の`migrateMcpConfigFile({apply:true})`。`.migration.lock`・exact backup・temp→rename | native `.native-write.lock`とは別protocol。applyは明示的なmaintenance ownerだけに限定し、他writer停止後に行う |
| native SDK settings保存 | [updater](../../backend/core/mcp-native-config-updater.mjs) → `runWriteSync` → [file writer](../../backend/core/mcp-native-config-file-writer.mjs) + [config attestor](../../backend/core/mcp-private-storage.mjs) | 固定の既存native global file/server、`enabled`/`exposure`だけ。両source hash・private storage・協調lockを検証。updaterはentered attempt後に消費済みとなり、再prepare/rebindが必要 |

[診断API](../../backend/src/mcp-migration-diagnostics.mjs)は`apply:false`固定で、`configuration-writers-not-quiesced`のまま。診断成功を停止確認やapply許可と解釈しない。

## reload／停止で代用できない点

- [harness](../../web/src/lib/pi/harness.ts)の`reloadLiveSessionsContext`はbusy sessionを`deferred`にし、他を`reloadSession`する。全session終了・新規作成停止・writer quiescenceのbarrierではない。
- ON/OFF actionは保存応答後に`setImmediate`でreloadする。HTTP成功はnative generation publication／接続収束を保証しない。
- 同harnessの`DefaultResourceLoader`は`bundledExtensionEntries`を`additionalExtensionPaths`へ渡し、既存`sessionExtensionFactories`にnative準備factoryはない。[extension discovery](../../web/src/lib/extensions.ts)にはadapterのbundled replacementも残る。既存sessionのreloadだけでadapterが排除されたとは扱わない。
- adapterの`session_shutdown`はbridge解除・owner abort・manager/OAuth cleanupを行うが、例外をlogして終わる。event発火だけでは全cleanup成功の証拠にならない。
- OAuth removeはadapter側でpending runtimeとmanager closeまで扱う。native credential fileの削除だけに置換すると、進行中refresh/callbackが再保存する可能性を残す。
- [coordinator](../../backend/core/mcp-native-write-coordinator.d.mts)の`drain`は既受付workの待機であって受付freezeではない。`dispose`も実行中workの強制中断／rollbackではない。跨process・OS ownershipの代わりにしない。

## 次の最小実装

**production WebUIのprofile mutationをfail-closedにする。**

- `/api/profile`のPOST(import)、PUT(restore)、DELETE(reset)、PATCHの`restore-packages`を、既存runtime ownership判定に従って処理の前に拒否する。
- Backendへのprofile mutation委譲が未提供の間は、明示的な非ownerエラーを返す。受付成功、local fallback、stop/restartの推測はしない。
- GET/export/listとbackup-only操作はこのconfig writer問題とは分離する。dev/testのlocal owner動作は維持する。
- 回帰テストで非owner時のprofile archive解析・mutation library・package processが未呼出、owner時の既存処理が維持されることを確認する。
- これはwriter集約の第一歩だけで、MCP移行applyを解除する条件ではない。

## その後の切替順序（すべて未完了）

1. Backendに単一の設定ownerを合成する。明示process authority、固定path、loader revision、generation/coordinator、実ACL attestor、同期IOを束ねる。SDK `updateConfig`は同期完了／throwを維持し、成功を先に返すasync enqueueを使わない。
2. ON/OFF、preset、auth selector、profile等の変更受付を同ownerへ集約する。settings-only writerにdocument作成・preset・credential移行を押し込まず、非対応operationは明示拒否する。旧writerのcallbackを残したままnative generationを公開しない。
3. maintenance受付gateを閉じ、新規session/子session/command/管理変更と外部writerを停止する。既受付async work、OAuth callback/refresh、遅延reloadを待機／取消・fenceし、実ownerを確認する。未知のwriterやcleanup失敗があればapply不可を維持する。
4. 承認された影響・復旧手順の下で、両sourceの最新revision・URL変数・非互換・ACL・private backupを再検証して一度だけ移行する。global file不在時の初回作成も別途手順が必要。現native settings writerは作成／importをしない。
5. gateを閉じたままnative factory・codemode/tool_search・auth bridge・Bot/subagentのnested permissionsを接続し、adapterをdiscovery/packageから除外する。全native snapshotを新規prepareし、fresh generation・credential authority・updaterをbindしてnative sessionを再構築する。旧adapterを読み直してからnativeへ差し替える二重起動はしない。
6. 同ownerの保存→再prepare/rebind→session reload/publicationを検証してから受付を再開する。失敗や部分writeでは旧leaseを復活させず、管理変更と新規接続を閉じる。保存済みとpublication済みを区別する。旧adapterのCLI/bridge/source・writerを撤去し、SSE、imports、Apps/sampling/elicitation等の不足を黙って落とさない。
7. 実serverのconnect/tool/auth/save、busy/deferred、再起動、権限拒否、refresh/取消、競合、失敗復旧とbuild/typecheckで受入確認してから完了とする。prep fixtureの成功を本番受入に数えない。

## 影響・復旧条件

- maintenance中は設定変更・新規MCP接続が一時停止する。session再構築で進行中tool/OAuthへ影響し得るため、作業中sessionを無断で切り替えない。
- temp fsync/renameはfilesystem CASやdirectoryのpower-loss durabilityではない。source hashの再確認だけで外部writer停止を証明しない。
- write/cleanupの例外はrename後の部分成功もあり得る。まず受付を閉じて実ファイルrevisionとprivate backupを照合する。無条件rollbackや古いsnapshot再公開は禁止。
- 移行前backupへ戻す場合も全writer停止・native session停止・owner/ACLの再確認が必要。必要な停止／起動・credential復元を明示承認の手順で実行し、旧writerが同時に復活しないようにする。
- profile rollbackとMCP migration backupは別物。資格情報とconfigの整合性を個別確認し、secret・SID・ローカルpathをpublic DTO/logへ流さない。
