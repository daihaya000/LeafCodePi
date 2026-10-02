# アカウントルーティング・内部再開の再発防止

2026-10-02 の追加調査で確認した境界条件と保護。初期設計の「実行時は使用量を取得しない」はこの対策で変更した。

## 使用量キャッシュ

- `resolveIntegratedModelRoute` はキャッシュが未取得・5分超なら、サーバー側で使用量を取得してから順位付けする。ブラウザのウィジェット表示を前提にしない。
- 待機は最大8秒。同時要求・Next.jsの別route moduleで取得を共有する。
- 取得失敗・タイムアウト・キャッシュされない結果は30秒の再試行抑制。鮮度確認では古いキャッシュを削除しない。
- 更新できなければ、既存の最大30分last-known／使用量不明の順位付けで続行する。使用量が取得できない場合や取得後に上限を超えた場合、上限エラーを完全には予防できない。
- 待機上限はルーティング側の上限。ブラウザと共有する取得を中断せず、遅れて完了した値も利用する。

## 実行時の上限マーク

- 新しい上限レスポンスはキャッシュの使用率・credits・resetより優先する。
- マークのresetが不明なら不明のまま除外する。古いスナップショットの過去resetを継承すると、新しいマークが即座に失効したと誤判定される。
- 上限マークがない場合、reset済みの100%スナップショットはfreshではなくunknown（tier 2）として扱う。

## SDK互換性・内部再開

- Pi SDK 1.0の `agent.state.systemPrompt` はgetter-only。直接代入しない。旧SDK向けの更新は `Reflect.set` で試み、予期しないsetter例外まで握りつぶさない。
- SDK 1.0の `sendCustomMessage({display:false}, {triggerTurn:true})` は `before_agent_start` を経由しない。フォールバック・通信復旧・Code結果通知は非表示メッセージ自体に実行時刻を含める。
- 模擬sessionのstateもgetter-onlyにし、アカウント／プロバイダーを切り替えた後のhidden resumeが完了するまで検証する。切替成功だけでテストを終えない。
- 実際の `Agent` と `AgentSession`＋faux providerを使う契約テストで、API変更と通常／内部ターンの違いを検出する。テストで外部プロバイダーへ送信しない。

## 関連検証

`web/` から実行する。

```sh
npm exec -- vitest run src/lib/provider-routing.test.ts src/lib/pi/routing-usage.test.ts src/lib/pi/harness-prompt.test.ts src/lib/pi/harness-routing.test.ts src/lib/pi/harness-limit-fallback.test.ts src/lib/pi/recovery-sdk.test.ts
```

SDK更新時は、内部再開を含む上記テストと関連型チェックを確認する。変更の反映にはビルド更新と実行を所有するruntimeの再起動が必要。稼働中タスクを中断して検証しない。
