# Upstream snapshot

- Repository: https://github.com/injaneity/pi-computer-use
- Tag: `v0.5.1` (`4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62`)
- Source archive: npm `@injaneity/pi-computer-use@0.5.1`
- Archive integrity: `sha512-eBYKTUYfLeaCE33TF6CBb0rklXbgS/4GNDsnl+cBTXv6HTkkMc/Gq/ft3RdcDL0hiRmQBwU9Ohx9jWz4r/l9xQ==`
- Windows helper SHA-256: `D3EF7E59BC03C421D6D29DE53750C343CC1BB2F126AA23224241FDFD5C3A7094`
- License: MIT (`LICENSE`)

The npm archive contains the Windows prebuilt executable; the Git tag does not. This snapshot contains the upstream TypeScript source, Windows Rust source and prebuilt helper, entry source, and setup script. Linux/macOS native binaries and documentation were not copied. Platform TypeScript modules remain present for imports.

`index.ts` loads the fork only on Windows. The Windows helper runs directly from the vendored `prebuilt/windows/windows-bridge.exe`; startup never installs or launches it. `scripts/setup-helper.mjs` remains as an upstream reference and must not run automatically. Browser use stays disabled by policy. macOS/Linux native assets and namespace changes remain out of scope.

## Windows verification

- Verified locally: the pinned helper answered `diagnostics` (protocol 4), then `listRoots({ pid })` and `look({ rootRef, includeImage: false, readText: "never" })` found a disposable WinForms window and its UIA label without capturing an image. The probe window was closed afterward.
- The actual LCP `act_ui` approval dialog and a post-approval action are **not yet verified**. The current testing session does not expose `act_ui` via `tool_search`; the permission-gate unit test covers denial, one-action approval, and text redaction only.
- To finish, use a fresh interactive LCP session with the desktop tools exposed, target only a disposable non-browser window, reject one `act_ui` request and confirm no action, then explicitly approve one harmless action and verify its result. Never send `act` directly to the helper to bypass the gate. Close the test window afterward; avoid private UI text and screenshots.
