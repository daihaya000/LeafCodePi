# leafcode-memory upstream policy

- Base: `https://github.com/chandra447/pi-hermes-memory`
- Base tag: `v0.9.6`
- Base commit: `1c1b2ed3c4fb2623a2868aa2b5432820713d941f`
- Fork version: `0.9.6-leafcode.0`

## Compatibility contract

The first fork release keeps these interfaces compatible with pi-hermes-memory:

- tool names and schemas: `memory_search`, `memory_add`, `memory_replace`, `memory_remove`, `session_search`, `skill_manage`
- configuration path and keys: `~/.pi/agent/hermes-memory-config.json`
- storage roots: `~/.pi/agent/pi-hermes-memory/` and `~/.pi/agent/projects-memory/`
- Markdown memory format, SQLite schema, FTS5 search, WAL, and lock behavior
- Pi extension entry point: `src/index.ts`

Do not load this fork and `pi-hermes-memory` in the same Pi process: their tools and commands intentionally have the same names.

## Upstream sync

1. Import the upstream tag or commit into a separate review branch.
2. Run `npm run check` and `npm test` before resolving fork changes.
3. Review storage, tool schemas, prompt injection, secret scanning, SQLite, and lock changes.
4. Run the compatibility and parallel-session checks before merging.
5. Keep custom LeafCode behavior in separate modules where possible.

The storage namespace remains `pi-hermes-memory` deliberately so rollback to the upstream package does not require data migration.
