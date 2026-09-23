# Upstream snapshot

- Repository: https://github.com/injaneity/pi-computer-use
- Tag: `v0.5.1` (`4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62`)
- Source archive: npm `@injaneity/pi-computer-use@0.5.1`
- Archive integrity: `sha512-eBYKTUYfLeaCE33TF6CBb0rklXbgS/4GNDsnl+cBTXv6HTkkMc/Gq/ft3RdcDL0hiRmQBwU9Ohx9jWz4r/l9xQ==`
- Windows helper SHA-256: `D3EF7E59BC03C421D6D29DE53750C343CC1BB2F126AA23224241FDFD5C3A7094`
- Linux x64 helper SHA-256: `671658D3DD237B5DC86BBA0786A3CF48A9173EC24B9AA6775CB597B61B335EB9`
- Linux arm64 helper SHA-256: `42E11B2E77FA3F9EC4B858C99CBC28703D086ACC84C2BD19DF2FB3DBCEEAB759`
- License: MIT (`LICENSE`)

The npm archive contains the Windows prebuilt executable; the Git tag does not. This snapshot contains the upstream TypeScript source, Windows and Linux Rust sources and prebuilt helpers, entry source, and setup script. macOS native binaries and documentation were not copied. Platform TypeScript modules remain present for imports.

`index.ts` loads the fork only on Windows and Linux. Helpers run directly from the vendored `prebuilt/windows/windows-bridge.exe` or `prebuilt/linux/<x64|arm64>/linux-bridge` (Git mode 755); startup never installs or launches them. `scripts/setup-helper.mjs` remains as an upstream reference and must not run automatically. Browser use stays disabled by policy. macOS remains out of scope.

## Linux (Ubuntu) requirements

- A desktop session with the AT-SPI accessibility bus (GNOME default). Outline, semantic press/setText, read_text, and wait_for use AT-SPI.
- Screenshots, coordinate clicks/drags, and forced focus require X11 (`x11: true` in diagnostics). On Wayland, only semantic AT-SPI actions work; the portal is probed read-only and never used for input.
- The helper links only glibc (`libc`, `libm`, `libgcc_s`). Linux runtime behavior is **not yet verified** on a real Ubuntu desktop.

## Windows verification

- Verified locally: the pinned helper answered `diagnostics` (protocol 4), then `listRoots({ pid })` and `look({ rootRef, includeImage: false, readText: "never" })` found a disposable WinForms window and its UIA label without capturing an image. The probe window was closed afterward.
- The actual LCP `act_ui` approval dialog and a post-approval action are **not yet verified**. The current testing session does not expose `act_ui` via `tool_search`; the permission-gate unit test covers denial, one-action approval, and text redaction only.
- To finish, use a fresh interactive LCP session with the desktop tools exposed, target only a disposable non-browser window, reject one `act_ui` request and confirm no action, then explicitly approve one harmless action and verify its result. Never send `act` directly to the helper to bypass the gate. Close the test window afterward; avoid private UI text and screenshots.
