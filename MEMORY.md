# LeafCodePi session memory

Updated: 2026-10-02

## Build restart loop (resolved)

- **Symptom**: Host repeatedly rebuilt production web, failed typecheck, exited 1, supervisor restarted → loop.
- **Root cause**: `web/src/components/task/TaskView.tsx` ~2368 used `"reason" in err` on `unknown` (`TS18046`). Parallel typecheck gate in `scripts/build-web.mjs` discarded the build; Host treated sources as still newer than `BUILD_ID` and failed hard in prod.
- **Fix**: Narrow `err` with `typeof err === "object" && err !== null` before `"reason" in err`.
- **Prior fix**: dead-PID `.leafcode-pi-deps.lock` reclaim (`df5e6e18`) stopped EEXIST Pi sync loop.

## Goal Loop stuck at 送信待ち / queued (resolved)

- **Session evidence**: `01a0efaf-fc6d-7547-9ffa-19d9971df027` — goals-loop stayed `queued` turnCount=0; task `55fa9adb-…` stayed `working` with an active lease; loop file never updated after create.
- **Root cause**: `goalLoopCommand` start/resume called `prepareLiveForPrompt` **without** `deferWorking`, so working+lease were reserved before the first `sendTurn`. When send could not enqueue, `releaseGoalLoopTurn` also refused to clear if `isLiveBusyForReplace` (e.g. compacting), stranding 送信待ち.
- **Fix**: defer working on start/resume prepare; release prepared turns unless `promptActive`; recover stranded working+queued on the next prepare.
- **Ops follow-up (2026-10-02 recheck)**: User Host restart still reused stale `runtime.bundle.mjs` because the stamp fingerprinted only `backend-runtime-entry.ts` (+ core/shared), not transitive `@/` sources like `harness.ts`. Stamp now includes all of `web/src`. Force-rebuild + Host restart loaded the fix; PATCH resume on `55fa9adb` advanced loop to `running` turnCount=1.

## Backend runtime stamp miss (resolved)

- **Symptom**: After harness Goal Loop fix and Host restart, log still showed `[backend-runtime] reused …/runtime.bundle.mjs` and `goal_turn_reservation_recovered` was absent from the bundle.
- **Root cause**: `backendRuntimeSourceStamp` roots were `[entry.ts, CORE, SHARED]` only — harness changes did not change the stamp hash.
- **Fix**: `scripts/build-backend-runtime.mjs` stamps `[WEB_SRC, CORE, SHARED]` so any Web source pulled into the bundle invalidates reuse.

## Stamp / reuse-gate audit (2026-10-02)

Similar under-fingerprinting survey after the runtime-stamp fix. Ranked leftovers:

1. **Defect (residual)**: `backendRuntimeSourceStamp` still omits inlined `node_modules` (+ `package-lock.json`). esbuild metafile for the runtime entry has 816 inputs; first-party roots cover all non-`node_modules` paths (`outsideRoots: []`), but inlined packages include `yaml`, `undici`, `typebox`, `jiti`, `@bufbuild/protobuf`, `@rahularya01/pi-cursor`. Stamp only hashes WEB_SRC+CORE+SHARED + web/backend `package.json` size/mtime — lockfile-only or node_modules refreshes can reuse a stale bundle.
2. **Defect**: `ensureExtensionDependencies` (`scripts/build-web.mjs` ~206) skips `npm ci` when each declared dependency folder exists — no lock/package fingerprint (unlike `ensureBuildDependencies`).
3. **Test gap**: `scripts/build-backend-runtime.test.mjs` injects custom roots; does not regress that default roots are `WEB_SRC` (not entry-only) or that `harness.ts` invalidates the stamp.
4. **Latent**: stamp ignores `scripts/build-backend-runtime.mjs` itself (banner/alias/external changes).
5. **Latent**: `isWebBuildStale` extension allowlist omits image/font types; currently only `.svg` assets under `public/` (watched). Safe today.
6. **Safe**: web mirror `isUpToDate` (size/mtime then byte compare); build-deps stamp (package.json+lock+Node); `isWebBuildStale` watches `src`/`public`/`shared`/`backend/core` (+ configs); computer-use `copyIfChanged` content hash.
7. **Docs**: MEMORY describes the fix correctly; no doc still claiming entry-only stamp coverage.

## Message revert failure with Goal Loop (resolved)

- **Symptom**: UI shows `巻き戻しに失敗しました` while Goal Loop badge (`ループ 1`) is visible; task often looks idle after `Request was aborted`.
- **Root cause**: `isTaskRuntimeBusyForDestructiveEdit` treats any owned Goal Loop (`queued`/`paused`/`blocked`/…) as busy, but TaskView only gated revert on `working`. Between turns the user could confirm revert → Backend 409 → cutover forward collapsed to the generic error. Yellow `巻き戻し中` can remain from an earlier successful leaf or SSE.
- **Fix** (`revertTask` / `unrevertTask`): call `stopGoalLoopForTask` before `assertIdleForSessionTreeEdit`. Forwarded 409 now surfaces the busy Japanese message.
- **Follow-up**: Backend task-action catch now forwards short Japanese 4xx messages (`badRequest`/`notFound`) while English/provider text stays `Backend task action failed`. `backend-client` + `forwardTaskRevert`/`Unrevert` carry `error` to the WebUI route.
- **Tests**: harness-revert, harness-tree-edit, task revert/unrevert route tests, server Japanese busy refusal, backend-forward 409 body.

## Remote git pull failed (exit 128) — expected / non-fatal

- Host runs `git pull --ff-only` on startup (`host/src/git-pull.js`). On divergence it logs ERROR and continues with local sources.
- Current state (2026-10-02): `master` is **ahead 10+, behind 2** vs `origin/master` (merge-base `f5c3c0ca`).
  - Local-only: cutover/perf + deps lock + TaskView typecheck (`79df8123` …).
  - Remote-only: `d06f30f9` (質問カード), `fe8e0092` (狭幅ヘッダー).
- Not a crash; Host keeps running local tree. To silence: merge/rebase remote then push, or push local and accept remote lag.

## Cutover work (prior)

FE/BE cutover under `/goal` landed through commits `c07cc05f` … `de49dc90` (todoProgress, Room dirty, Sidebar poll, idle Todo bar disk fallback).

## Ops notes

- Host log: `%APPDATA%\leafcode-pi\host.log`
- Prod mirror: `%LOCALAPPDATA%\leafcode-pi\build\leafcodepi-*`
- After TaskView / harness / stamp fixes, restart Host so Backend attaches a current `runtime.bundle.mjs`.
- Host control: `http://127.0.0.1:18775` (`POST /restart/host` reloads runtime even when Backend restart is blocked by a live Goal Loop).
