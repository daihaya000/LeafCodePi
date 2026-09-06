# Bot mode improvement plan

## Phase A - reliable routine and Bot configuration
- Make the 1:1 routine confirmation card the primary creation path; keep settings as a secondary path.
- Persist and show routine failures and automatic disable notices in the 1:1 Bot view.
- Add per-Bot skill inherit/include/exclude lists and a minimal absolute `extraRoots` editor.
- Keep Phase A surfaces and API errors Japanese and verify encoding.

## Phase B - operational clarity
- Add routine history, last-error details, retry controls, and clearer scheduler health.
- Improve skill discovery/validation and configuration summaries.

## Phase C - richer Bot workflows
- Add structured routine proposals from Bot responses and reusable routine templates.
- Add audit/history views and safe bulk configuration tools.

## Phase D - automation extensions
- Consider event triggers, richer scheduling, and controlled Bot-to-Bot workflows behind explicit guards.
- Goal Loop integration remains separate unless a later design explicitly requires it.

## Deferred
- Computer/isolation work on X870 is explicitly deferred; `extraRoots` is persisted/UI-only in Phase A.
