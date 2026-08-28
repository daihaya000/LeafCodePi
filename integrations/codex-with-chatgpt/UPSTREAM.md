# Upstream provenance

- Project: [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
- Base commit: `b4e0b14782519bae60236ffaa6120673887fecaa`
- Base version: `0.1.0`
- License: MIT (see `LICENSE`)

This directory is a fixed LeafCodePi-managed fork. It is not updated at runtime.

## LeafCodePi patches

- Pin all direct dependencies to the versions resolved during the reviewed upstream build.
- Use `pathToFileURL()` before importing the compiled CLI entry on Windows.
- Use LeafCodePi-specific package, service, and state namespaces.
- Keep upstream source and tests isolated from the root web/host dependency graph.

The upstream README, Skill, and pnpm workspace metadata are intentionally not copied
because LeafCodePi does not use the upstream Codex browser workflow or package
manager at runtime.
