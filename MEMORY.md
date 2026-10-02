# LeafCodePi session memory

Updated: 2026-10-02

## Build restart loop (resolved)

- **Symptom**: Host repeatedly rebuilt production web, failed typecheck, exited 1, supervisor restarted → loop.
- **Root cause**: `web/src/components/task/TaskView.tsx` ~2368 used `"reason" in err` on `unknown` (`TS18046`). Parallel typecheck gate in `scripts/build-web.mjs` discarded the build; Host treated sources as still newer than `BUILD_ID` and failed hard in prod.
- **Fix**: Narrow `err` with `typeof err === "object" && err !== null` before `"reason" in err`.
- **Also seen**: remote `git pull` FF abort (diverging branches) — non-fatal; Host continues with local sources.
- **Prior fix**: dead-PID `.leafcode-pi-deps.lock` reclaim (`df5e6e18`) stopped EEXIST Pi sync loop.

## Cutover work (prior)

FE/BE cutover under `/goal` landed through commits `c07cc05f` … `de49dc90` (todoProgress, Room dirty, Sidebar poll, idle Todo bar disk fallback).

## Ops notes

- Host log: `%APPDATA%\leafcode-pi\host.log`
- Prod mirror: `%LOCALAPPDATA%\leafcode-pi\build\leafcodepi-*`
- After TaskView fix, restart Host so a fresh rebuild can succeed and clear the stale loop.
