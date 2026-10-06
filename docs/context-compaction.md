# LCP context compaction

## Scope and ownership

LCP owns compaction in `web/src/lib/pi/compaction-controller.ts`. The memory extension asks the session-local event bus (`leafcode:compaction:owner`) before doing any auth/model work and yields to that owner. Standalone Pi, without the LCP host, retains the memory extension's existing single-pass path. No external compaction package is installed.

The host uses one pipeline for manual, threshold, overflow and background requests:

1. Existing Jev selection, only when explicitly enabled and applicable.
2. Configured compaction model/account.
3. Session model if the configured route is unavailable or fails.
4. Pi's native compaction if the host hook fails.

Successful LLM summarization combines history and split-turn prefix into one request, including the previous checkpoint. Output defaults to 4,096 tokens independently of `reserveTokens`. Truncated, empty and aborted outputs are not committed. File-operation metadata from the prior checkpoint is merged because Pi does not automatically carry hook-generated file details forward. Applied LLM checkpoints retain `usage` and `details.leafcode` (mode, elapsedMs, output budget).

## Background compilation

This implements the snapshot/background/atomic-boundary approach described by [pi-hot-compact](https://pi.dev/packages/pi-hot-compact), not that package's code or full feature set.

- Starts **preparation only** at 70% occupancy by default, or five percentage points before the native threshold if that is earlier. Requires auto mode, enabled native compaction and a live non-Goal-Loop LCP task. A ready checkpoint stays pending below the effective native threshold: readiness does not change history, invalidate the prompt prefix, or lower the configured compaction threshold.
- Keeps Pi's configured recent-token budget. Uses public `buildSessionProjection` + `findCutPoint`: existing context edits and omissions are respected, system-prompt state is excluded from summarization, and tool-call/result pairs stay together. Pi 1.0 does not export `prepareCompaction` at the package root, so no private deep import is used.
- Requires roughly 6,000 new tokens (chars/4 heuristic), uses one speculative job per session, a 120-second request timeout and a 30-second cooldown. Model inference is asynchronous, not an extra agent turn; preparation still runs on the Node event loop.
- Commits only when `contextTokens > contextWindow - reserveTokens`, by returning a `compaction` draft at `turn_end` / `agent_before_settle`, or serving Pi's own threshold/overflow hook. Pi persists it, recalculates pre-compaction tokens and rebuilds the canonical context. The untouched suffix, including work completed during generation, remains verbatim. No direct session-file mutation or forced continuation.
- Validates session ID, snapshot prefix IDs and route/settings identity. New compactions/context edits, tree navigation, forks, model switches, shutdown/reload or user abort invalidate the job. Already-staged edits from another boundary handler also prevent application.
- A ready checkpoint may serve native threshold/overflow compaction if still valid. Manual `/compact` (especially custom focus) always generates a fresh checkpoint. An unfinished speculative request is aborted when native compaction takes over.
- Failed, stale, empty, non-shrinking or timed-out results are discarded; the native threshold/overflow mechanism remains the fallback. A provider that ignores abort cannot accumulate more speculative jobs.

Original history remains in Pi's append-only session log, recoverable through existing session-history/search facilities. There is no new recall tool, vector store, every-turn pruning, or deterministic emergency history deletion. This avoids a second memory system and repeated prompt-cache invalidations. Background compaction still invalidates the cached prefix once applied; it hides generation latency, not all total cost.

## Server settings

Use the existing authenticated settings API, `PUT /api/settings/<key>` with `{ "value": "..." }`. Values are strings; `null` resets the default. The server's settings store is authoritative, not localStorage. The context-savings settings card exposes a background-preparation switch and its start threshold; both controls are inactive outside auto mode. Manual compaction and Goal Loop retain their ordinary paths.

| Key | Default | Accepted values |
| --- | --- | --- |
| `compaction-background-enabled` | enabled | `"0"` disables; `"1"` enables |
| `compaction-background-threshold` | `70` (preparation only) | Integer `50`–`85` |
| `compaction-summary-max-tokens` | `4096` | Integer `512`–`16384` |

Existing `compactionAction`, `compaction-model`, `compaction-model-effort`, Jev and native per-model keep/reserve settings remain in effect. Summary budget applies to the host's generative path; the existing Jev transcript-selection path and Pi's last-resort native fallback retain their own budgets. Changed settings are read on subsequent boundaries/requests; disabling background compaction discards outstanding results at the next boundary. To stop an in-flight run immediately, use the ordinary Stop action.

New code requires a runtime reload/restart to activate. Do not restart an active Goal Loop or the running agent's host without arranging a safe handoff. Existing sessions need their extension runtime reloaded; persisted checkpoints do not require this extension to resume.

## Diagnostics and verification

`leafcode:compaction:status` emits session-local phases (`running`, `ready`, `applied`, `cancelled`, `failed`, `skipped`, `timeout`). These are not transcript messages or UI notifications. `applied` means handed to Pi for commit; the persisted compaction entry is the durable source of truth. Usage in session totals covers committed summaries; discarded background requests can still incur provider charges and are not currently added to session totals.

Tests cover single-pass generation and budgets, ownership, snapshot invalidation, timeout/abort, stalled providers, non-blocking boundaries, custom instructions, projection edits, tool-pair integrity, repeated checkpoints and SDK replay. Real SDK tests use a faux provider and make no external model calls.

The existing safety reserve is unchanged: ordinary sessions reserve at least 10% of the context window, so a UI threshold of 95% may have an effective native threshold of 90%. The settings card explains this separately from the preparation threshold. Preparing earlier does not override this boundary; no speculative generation is launched after native compaction is already due.

Before measuring production speed, compare the same task and model with background enabled/disabled. Record compaction request count, p50/p95 blocking time, next-response TTFT, cache-read/write tokens, provider usage (including discarded jobs), exact fact retention and history-retrieval frequency. Unit tests demonstrate control-flow correctness, not real-provider speed or summary quality.
