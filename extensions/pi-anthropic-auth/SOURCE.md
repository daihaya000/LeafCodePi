# Bundled pi-anthropic-auth

- Upstream: https://github.com/gotgenes/pi-anthropic-auth
- npm: `@gotgenes/pi-anthropic-auth@3.3.3`
- License: MIT (see `LICENSE`; upstream copyright retained)
- npm tarball SHA-512 (base64): `CIIw4QHhP0boZNJLn0GYRL78fOXOmYS5fSFxe1TjRHYdXTGaOQwe6zmyGf/mNJTvi9oSppse83Tcj6jYwwtNlQ==`

## Local integration

`src/`, `README.md`, `CHANGELOG.md`, and `LICENSE` are unmodified npm release files. A root `index.ts` re-exports the upstream factory, and `package.json` points `pi.extensions` at that entry (also included in `files`). This keeps discovery and the optional extension toggle keyed as `pi-anthropic-auth`, not `src`.

LeafCodePi discovers this directory as a bundled extension. The harness excludes the installed scoped npm package before loading extensions and removes stale same-name copies. The extension is optional, not a required `leafcode-*` component. No credentials, endpoint overrides, warning suppression, or additional request-shaping rules are bundled.

The native Anthropic login, diagnostic command `/anthropic-auth:status`, and configuration path `~/.pi/agent/extensions/pi-anthropic-auth/config.json` remain unchanged. CLI users can install this directory with `pi install ./extensions/pi-anthropic-auth`; remove the old npm registration to avoid loading both copies outside LeafCodePi.

This extension does not guarantee acceptance, billing treatment, or compliance with Anthropic's subscription terms. The upstream extra-usage warning is not disabled by bundling it.

## Updating

1. Download an explicit npm version with `npm pack @gotgenes/pi-anthropic-auth@<version> --ignore-scripts` and verify its registry integrity.
2. Replace the upstream files listed above, retaining the root entry and manifest adjustments. Never copy local configuration or authentication data.
3. Update this provenance record; review upstream peer requirements and source changes.
4. Run the extension discovery/replacement tests and the isolated SDK load test in `web/src/lib/pi/anthropic-auth-bundled.test.ts`. Run the diagnostic command without making a model request.
