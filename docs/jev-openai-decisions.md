# OpenAI Decisions を Jev 形式で使う

1. 設定のプロバイダー接続で **OpenAI** の API キーを登録する。`openai-codex` のサブスク認証は対象外。
2. Jev モデル設定を更新し、OpenAI の **gpt-6-luna** を有効にする。モデルカタログ未掲載でも、認証済みの OpenAI 接続から検出される。
3. 既存の `jev_judge`・Auto・圧縮などをそのまま使う。既存選択は自動で変更しない。

## 変換

`web/src/lib/pi/openai-decisions.ts` が HTTP 境界で変換する。

| Jev | Decisions |
| --- | --- |
| `state` | `input`（オブジェクト・配列は JSON 文字列） |
| 質問マップのキー | `questions[].name` |
| `noul` | `predicate` |
| Noul の `criteria.true/false` | `instructions` に基準を追記 |
| Choice の `criteria` | `choices` の `value/description` |
| Score の `criteria` | `levels`（順序維持、ラベルは0始まりのインデックス） |
| `probability` | `noul` |
| `answers` 配列 | 名前をキーとした Jev 回答マップ |
| `probabilities` 配列 | 値・レベル番号をキーとした確率マップ |

Choice/Score の confidence、確率分布、Score の小数値と legend、モデル名・usage を保持する。共有 validator で値域・型・欠落を検証し、変換層で回答名の重複・未知の選択肢・不正な分布を拒否する。refusal は有効な判断として扱わず、リクエスト失敗にする。

接続解決が返す `api` に従い、`decisions` なら `<baseUrl>/decisions` に送って変換し、`systemone` なら従来の `<baseUrl>/systemone` を使う。プロバイダー名では分岐しない。認証・接続URL・追加ヘッダー・タイムアウト・キャンセル・レイテンシ計測・明示選択したモデル間のフォールバックは既存経路を利用する。OpenAI/OpenRouter などの利用を TypeSafe の使用量には加算しない。

## 他プロバイダーの将来対応

`web/src/lib/jev-model-catalog.ts` の `jevModelApi` がモデルの wire contract を解決する。

- `api: "decisions"` / `"openai-decisions"`、または `supported_endpoints` に `/decisions`・`/v1/decisions`・`/api/v1/decisions`・`/provider/v1/decisions` があれば Decisions として扱う（末尾スラッシュ可）。モデル名やプロバイダーは問わない。
- 明示された System One 契約は優先する。両形式を広告するモデルも既存動作を維持する。
- OpenRouter/CommandCode の公開カタログは、SDK の通常チャット行にない API 契約を補完できる。カタログが新APIを明示すれば、更新/再検出後に Decisions として利用できる。他のプロバイダーはネイティブのモデルメタデータで指定できる。
- ネイティブの明示契約・classifier の非互換API・URL・追加ヘッダー・モデル別認証をリモート情報で上書きしない。リモートの `baseUrl` を信用せず、既存接続先だけを使用する。
- `architecture.output_modalities: ["decisions"]` だけでは OpenAI のHTTP形式を意味しない。既存の TypeSafe/OpenRouter/CommandCode 検出は、明示契約がなければ従来の System One のまま。
- OpenAI 直結の `gpt-6-luna` だけは公式仕様から Decisions を補完する。他社の同名モデルや `openai/gpt-6-luna` を名前だけで推測しない。旧手動互換接続も System One のまま。

将来の OpenRouter カタログの例（現在の実提供を示すものではない）:

```json
{
  "id": "openai/gpt-6-luna",
  "supported_endpoints": ["/api/v1/decisions"]
}
```

認証済みのモデルを Jev 設定で明示的に選択する必要がある。API提供・認証方式・利用料金は各プロバイダー側の対応に依存する。エラーを契機に未広告の別形式へ自動再送しない。

既存 Jev インターフェースはテキスト/JSON state のため、この対応では画像入力を追加しない。低 confidence は不確実として扱い、回答を不可逆操作の実行許可にしない。

## 仕様

- [OpenAI Decisions ガイド](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI Decisions API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [TypeSafe HTTP API](https://docs.typesafe.ai/api)

2026-10-07 時点: Decisions は public beta、対応モデルは `gpt-6-luna`。モデルのチャット対応は別のため、チャットレジストリを変更しない。ゲートウェイのURLを設定した場合は、その接続先にも Decisions endpoint が必要。
