# Field Journal — 経験库

逆向・渗透・安全研究の知見を蓄積する。各エントリはanonymizeし、秘密情報（API鍵・トークン・パスワード・個人データ）を含めない。

## エントリ一覧

- `precedent-auth.md` — 授权確認の前例
- `precedent-reverse.md` — 逆向関連の前例
- `precedent-pentest.md` — 渗透関連の前例
- `_template.md` — 新規エントリのテンプレート
- `anonymization.md` — 匿名化ガイドライン

## 新規エントリ追加手順

1. `_template.md` をコピーして `seed-NNN-<short-name>.md` を作成
2. anonymize済みの内容を記入
3. 本indexに追記
4. 任務完了時にコミット

## 規則

- 1エントリ = 簡潔に（WHY/HOW/RESULT 各1-3行）
- 秘密情報絶対禁止
- 矛盾時は新エントリ側を優先し、矛盾明記