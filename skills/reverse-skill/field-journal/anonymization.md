# Anonymization Guidelines

field-journalに記録する前に以下を必ず匿名化:

- ホスト名・IPアドレス → `target-1`, `internal-host` 等
- ドメイン名 → `example.com`, `target.tld`
- ユーザ名・メール → `user-a`, `attacker@anon`
- API鍵・トークン・パスワード → 絶対記録しない
- 社名・個人情報 → 一般名詞に置換
- バイナリハッシュ・ファイル名 → 機能性記述のみ（特定可能な場合は抽象化）

元情報との対応表はローカルの暗号化ストレージのみに保存し、リポジトリに含めない。