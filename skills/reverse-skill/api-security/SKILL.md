---
name: api-security
description: "REST/GraphQL/WebSocket API security testing. Triggers: api security, REST API, GraphQL, JWT, OAuth, WebSocket, API testing, BOLA, IDOR, API pentest."
---

# api-security — REST/GraphQL/WebSocket

## ACTION REQUIRED
1. 授权確認: ../field-journal/precedent-auth.md
2. tool-index確認: ../references/tool-index.md
3. ACT: 工作流第1步を実行

## 適用範囲
- 授权済み REST API / GraphQL / WebSocket endpoint
- OWASP API Top 10 全項目
- JWT/OAuth2 / API key 認証メカニズム

## 工具依存

| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| BurpSuite | yes | proxy / scanner / repeater | manual |
| Burp Autorize | recommended | 権限昇格テスト | BApp Store |
| jwt_tool | yes | JWT tamper / brute | git clone |
| Vespasian | optional | GraphQL security | pip |
| Entropy | optional | JWT secret entropy check | pip |

## 工作流

1. **endpoint enum**: `ffuf -u https://api.target/FUZZ -w common-api-endpoints.txt`; swagger/openapi 発見なら `swagger-ui.html`, `openapi.json` を取得。
2. **auth test**: `jwt_tool.py <token> -t -cv` で署名検証。none / RS256→HS256 切替。
3. **BOLA/IDOR**: `GET /api/v1/users/{id}` で id=1,2,3... を列挙、Autorize で low-priv→high-priv 差分。
4. **mass assignment**: `POST /api/users` に `role=admin` や追加フィールドを挿入。
5. **rate limit**: `ffuf` / Burp intruder で 100 req/sec 連打、`429` 有無確認。
6. **JWT tamper**: secret brute `jwt_tool.py -S -d secrets.txt <token>`; kid header injection。
7. **GraphQL introspection**: `{"query":"{__schema{types{name fields{name args{name}}}}}}"}`。disable 時は field 名推測。
8. **SSRF**: query param / webhook / file import で `http://169.254.169.254/` や `file:///etc/passwd`。
9. **WebSocket**: `wscat -c ws://target/ws`、メッセージリプレイ、auth bypass。
10. **report**: OWASP API Top 10 risk mapping、PoC curl、remediation。

## JWT/OAuth コマンド集

```bash
# algorithm confusion (RS256 -> HS256)
python3 jwt_tool.py $TOKEN -X k -pk public.pem

# secret brute
python3 jwt_tool.py $TOKEN -S -d secrets.txt

# kid header injection to arbitrary file
python3 jwt_tool.py $TOKEN -I -hc kid -hv "../../../dev/null"

# OAuth flow check: code reuse, redirect_uri mismatch, state missing
curl -X POST https://oauth.target/token -d "grant_type=authorization_code&code=$CODE&client_id=$ID&redirect_uri=$URI"
```

## GraphQL 具体例

```json
{"query":"query { __schema { types { name fields { name args { name } } } } }"}
{"query":"mutation { updateUser(id:1, role:\"admin\") { id role } }"}
```

## OWASP API Top 10 Quick Map

| category | test |
|----------|------|
| API1 BOLA | IDOR on object refs |
| API2 Broken Auth | JWT weak secret, brute force |
| API3 Excessive Data | response overexposure |
| API4 Lack of Resources | rate limit bypass |
| API5 BFLA | function-level access control |
| API6 Mass Assignment | extra fields accepted |
| API7 Security Misconfig | verbose errors, CORS |
| API8 Injection | SQLi, command injection |
| API9 Improper Asset | shadow/deprecated API |
| API10 Unsafe Consumption | SSRF via 3rd party |

## 按需自举

`../scripts/bootstrap.sh` / `../scripts/bootstrap.ps1` で Burp + jwt_tool 等をインストール。

## 路由上下文

- 上游: reverse-skill / web pentest
- 下游: pentest-tools（network layer）, malware-analysis（malicious sample）
- 同級: pwn-chain, patch-diff-exploit

## 任務完了自検

- [ ] 対象 API/scope を明記
- [ ] JWT/OAuth 検査結果と脆弱 token 例を記録
- [ ] IDOR/mass assignment/SSRF に再現コマンドあり
- [ ] `../field-journal/precedent-pentest.md` へ追記
