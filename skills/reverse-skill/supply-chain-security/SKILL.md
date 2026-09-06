---
name: supply-chain-security
description: >
  Software supply chain security: SBOM generation, SCA, secret scanning,
  artifact signing, CI/CD pipeline audit. Trigger on supply chain, sbom, sca,
  software composition analysis, trivy, syft, gitleaks, osv, cosign,
  dependency scan, ci cd security.
---

# Supply Chain Security

## ACTION REQUIRED
1. 授权確認: `../field-journal/precedent-auth.md`
2. tool-index確認: `../references/tool-index.md`
3. ACT: 工作流第1步 `SBOM generation` を実行

## 適用範囲
- SBOM 生成 (CycloneDX / SPDX) from source, container, or binary
- SCA: 依存ライブラリの脆弱性スキャン
- Secret scan: コミット履歴・コードベースからの漏洩検知
- Artifact signing / verification (cosign + Sigstore)
- CI/CD pipeline audit (6層治理: source → build → package → registry → deploy → runtime)
- Remediation priority: CVSS + EPSS + exploit availability

## 工具依存
| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| Syft | yes | SBOM generation | true |
| Trivy | yes | vulnerability / secret / misconfig scan | true |
| OSV-Scanner | yes | Google OSV dependency scan | true |
| Gitleaks | yes | git history secret scan | true |
| cosign | yes | container/image signing | true |
| jq | optional | SBOM JSON filtering | true |

## 工作流
1. **SBOM generation (Syft)**
   ```bash
   syft dir:. -o cyclonedx-json=sbom.cdx.json
   syft dir:. -o spdx-json=sbom.spdx.json
   syft <image:tag> -o cyclonedx-json=sbom-image.cdx.json
   ```
2. **vulnerability scan (Trivy + OSV-Scanner)**
   ```bash
   trivy fs --scanners vuln,secret,misconfig .
   trivy sbom sbom.cdx.json
   osv-scanner --format json -r .
   ```
3. **secret scan (Gitleaks)**
   ```bash
   gitleaks detect --source . --verbose --report-format json --report-path leaks.json
   gitleaks protect --staged
   ```
4. **sign / verify (cosign)**
   ```bash
   cosign generate-key-pair
   cosign sign --key cosign.key <image_digest>
   cosign verify --key cosign.pub <image_digest>
   ```
5. **CI/CD pipeline audit (6層)**
   - source: branch protection, CODEOWNERS, signed commits
   - build: reproducible build, pinned actions, runner isolation
   - package: dependency lockfile, private registry
   - registry: immutable tags, RBAC, signing
   - deploy: GitOps, policy engine (OPA/Kyverno)
   - runtime: SBOM attestation, runtime vulnerability alert
6. **remediation**
   - `trivy` / `osv-scanner` 結果を CVSS 降順で整理
   - upgrade patch version → 影響範囲 test → PR
   - 修正不能時: compensating control (WAF rule, network segment)

## 按需自举
- ツール不在: `bash ../scripts/bootstrap.sh syft trivy osv-scanner gitleaks cosign`
- Docker 不在: Trivy `fs` / `repo` モードで代替; Syft `dir:` スキャン
- Sigstore keyless: `cosign sign` (OIDC required, CI only)
- tool-index 不在: `bash ../scripts/refresh-tool-index.sh`

## 路由上下文
- 上游入口: `reverse-skill` master router / `references/routing.md`
- 下游出口: 悪性 artifact 解析 → `malware-analysis`; container escape → `pentest-tools`
- 同级关联: `llm-security` (ML model supply chain), `api-security` (registry API)

## 任務完了自検
1. 授权明記 (local-sandbox/CTF/owned/書面授权)
2. Syft / Trivy / OSV-Scanner / Gitleaks / cosign の実パスを `tool-index.md` で検証
3. SBOM → vuln scan → secret scan → sign/verify → CI/CD audit → remediation まで実行
4. 発見を `field-journal/precedent-pentest.md` または `_template.md` に蓄積
