# leafcode-memory upstream policy

- Base: `https://github.com/chandra447/pi-hermes-memory`
- Base tag: `v0.9.6`
- Base commit: `1c1b2ed3c4fb2623a2868aa2b5432820713d941f`
- Fork version: `0.9.6-leafcode.0`

## Runtime naming and migration

LeafCode-owned runtime names are:

- configuration: `~/.pi/agent/leafcode-memory-config.json`
- global storage: `~/.pi/agent/leafcode-memory/`
- project storage: `~/.pi/agent/projects-memory/`
- extension package: `leafcode-memory`

The first startup migrates the legacy roots `~/.pi/agent/memory/` and
`~/.pi/agent/pi-hermes-memory/` into the LeafCode global root. The legacy
configuration filename `hermes-memory-config.json` is accepted as a read-only
fallback when the LeafCode configuration file is absent. New installations must
use the LeafCode filename.

## Compatibility contract

The fork keeps the behavior-facing interfaces compatible with pi-hermes-memory:

- tool names and schemas: `memory_search`, `memory_add`, `memory_replace`, `memory_remove`, `session_search`, `skill_manage`
- configuration keys and values
- Markdown memory format, SQLite schema, FTS5 search, WAL, and lock behavior
- Pi extension entry point: `src/index.ts`

Do not load this fork and `pi-hermes-memory` in the same Pi process: their tools
and commands intentionally have the same names.

## Upstream sync

1. Import the upstream tag or commit into a separate review branch.
2. Run `npm run check` and `npm test` before resolving fork changes.
3. Review storage, tool schemas, prompt injection, secret scanning, SQLite, and lock changes.
4. Run compatibility and parallel-session checks before merging.
5. Keep custom LeafCode behavior in separate modules where possible.

Rollback requires stopping all Pi sessions, restoring the backup, and selecting
the upstream package. Do not run both package versions concurrently against the
same storage during rollback.
