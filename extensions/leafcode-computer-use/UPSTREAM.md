# Upstream snapshot

- Repository: https://github.com/injaneity/pi-computer-use
- Tag: `v0.5.1` (`4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62`)
- Source archive: npm `@injaneity/pi-computer-use@0.5.1`
- Archive integrity: `sha512-eBYKTUYfLeaCE33TF6CBb0rklXbgS/4GNDsnl+cBTXv6HTkkMc/Gq/ft3RdcDL0hiRmQBwU9Ohx9jWz4r/l9xQ==`
- Windows helper SHA-256: `D3EF7E59BC03C421D6D29DE53750C343CC1BB2F126AA23224241FDFD5C3A7094`
- License: MIT (`LICENSE`)

The npm archive contains the Windows prebuilt executable; the Git tag does not. This snapshot contains the upstream TypeScript source, Windows Rust source and prebuilt helper, entry source, and setup script. Linux/macOS native binaries and documentation were not copied. Platform TypeScript modules remain present for imports.

This is **not yet an enabled extension**: no `index.ts` is registered. The Windows config and helper paths now use the `leafcode-computer-use` namespace; `scripts/setup-helper.mjs` was relocated to match the native client's expected path. macOS/Linux paths and remaining upstream environment variables have not yet been forked. Before registration, restrict the entry to Windows and verify the helper without modifying global settings.
