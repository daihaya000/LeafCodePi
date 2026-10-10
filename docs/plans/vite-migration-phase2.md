# P2 — Vite + React SPA migration (increment 1)

## Scope and status

This increment adds an independently buildable SPA entry, browser navigation adapters, and settings admission. P2 as a whole is **not complete**. Existing Next entry/scripts remain available as the comparison baseline; no running service, Backend/Host owner, Goal Loop API/UI semantics, CSS, component markup, or assets are changed.

- `web/src/spa/main.tsx` replaces the server layout with React/ThemeProvider and a lazy protected application.
- `/`, `/task/:id`, `/settings`, `/bots`, `/bots/:id`, `/bots/rooms/:roomId`, `/login` reuse the existing client views. Task/settings/bot content continues to be owned by TaskPanesHost, preventing double mounting.
- `web/vite.config.ts` resolves `next/navigation`, `next/link`, `next/image`, `next/dynamic` to local browser adapters only for the SPA build. The legacy source imports remain for side-by-side comparison. These adapters bundle no Next runtime/RSC/layout implementation.
- History writes, popstate, hashchange, push/replace, query and decoded route params share a browser location store. TaskPanes' raw history.replaceState writes are observable.
- CSS is the existing `app/globals.css`; Vite uses an inline Tailwind PostCSS configuration because Next's string-array plugin declaration is not accepted by Vite's PostCSS loader.

## Settings admission

The SPA does not instantiate its protected lazy tree until `/api/settings` returns and validates a string/null snapshot. Actual AppShell Composer default writers consequently read the saved snapshot first. Module registration after fetching still applies that snapshot synchronously.

`ensureServerSettingsHydrated()` shares one promise and rejects on failure; the existing best-effort hydrate API retains its catch/log contract. Failed requests clear the promise for an explicit retry. Network/HTTP/invalid payload failure stays on a waiting/error screen without mounting writers. A 401 replaces the URL with `/login?next=...`, preserving the original query/hash in the encoded destination.

Existing per-key local-write sequence/pending queue rules remain intact. A response-order sequence additionally prevents an older GET from replacing a newer successfully applied snapshot. This is independent of the per-key local-write sequence captured when the GET began.

## Build and verification

From `web/`:

```text
npm run typecheck:spa
npm run build:spa
npx --no-install vitest run src/spa/navigation.test.tsx src/spa/SettingsGate.test.tsx src/spa/build-boundary.test.ts src/lib/setting-sync.test.ts src/components/shell/AppShell.test.tsx --maxWorkers=2
```

Evidence for this increment:

- SPA typecheck and production build pass; initial build transforms 2405 modules. Runtime graph gate rejects Next, SDK, Backend/Host/extension owners and API handler modules.
- 51 tests: navigation12 + settings admission8 + production boundary10 + existing setting-sync11 + existing AppShell10.
- Delayed GET, StrictMode/remount, network/503/invalid failure and retry, 401, persisted pending save, write during GET, and out-of-order snapshots are tested using real AppShell default initialization.
- Login uses the actual LoginForm plus SPA navigation: fragment is removed before POST, exactly one fixture token is posted, destination query/hash survives replace.
- Production preview tests build to an isolated temporary directory, serve all seven route forms twice (direct/reload), and proxy settings only to an ephemeral fixture. This checks HTTP fallback, not actual browser execution.
- Seven forbidden-import builds and three resolved-module guard probes are rejected. A non-credential canary in VITE_* and owner environment is absent from fixture HTML/JS. `envPrefix: []` disables custom client environment exposure.
- Tests use isolated storage/data/HTTP fixtures, no real credentials or SDK operations. Other sessions' Backend/Goal Loop/provider-overload changes are not staged.

## Commands and output

```text
npm run dev:spa
npm run preview:spa
```

Output: `web/dist-spa/` (ignored). API proxy defaults to `http://127.0.0.1:3010`; `LEAFCODE_SPA_API_ORIGIN` is a build-server-only override, never a VITE variable. No production service cutover/static gateway wiring is performed here.

## Remaining P2 acceptance

- Broader visual/pointer comparison beyond the finite desktop/mobile browser fixture below; pixel-diff and real-device touch coverage remain unclaimed.
- Browser notification delivery boundaries and global OFF/reconnect/remount are covered by increment 5. Additional tab/pane pointer/selection/restore interaction comparisons remain; actual OS toast/speaker and external Pushover delivery are not claimed by isolated browser fixtures.
- Additional provider-specific OAuth flows beyond the fixture's generic popup/manual relay/SSE completion contract.
- Server hostname/title/auth-file display parity is covered by increment 4 below. Broader browser-head/platform states and every metadata failure state remain outside finite parity claims.
- Source import conversion/final legacy-framework removal and build-warning/chunk review. Production artifact/browser secret canaries are covered by increment 3 below; arbitrary runtime API data and every possible encoding are not a formal security proof.
- The `use client` directives are intentionally retained in reused files and emit ignored-directive warnings during the Vite build; ProtectedApp also exceeds the chunk-size warning threshold. Build success does not claim performance/visual parity.

## Increment 2 — real-browser contracts and race corrections

`npm run test:spa:browser` in `web/` runs `scripts/spa-browser-contract.mjs`. Playwright 1.62.1 is a dev dependency only. Install its Chromium beforehand (`npx --no-install playwright install chromium`), or explicitly select an existing compatible browser using `LEAFCODE_TEST_CHROMIUM`. Evidence defaults to a temporary directory; `LEAFCODE_SPA_EVIDENCE_DIR` selects a private test output directory.

The harness builds both production Vite and an isolated production Next reference, uses ephemeral loopback ports and a finite API/SSE fixture, and blocks browser traffic outside those origins. Next's app layout receives the same controlled settings snapshot. In increment 2's historical run, reference hostname/login display path were normalized to the SPA's then-current values. Increment 4 removes these substitutions and compares the actual server-derived values. The reference reuses the current presentation sources (including the Room race fix), not a frozen historical UI archive. Unknown/nonessential owner endpoints return explicit fixture 503 responses; this is not a fully operational SDK/Host simulation.

Verified with Chromium **153.0.8010.12**:

- **18 real-browser cases pass**: 7 routes × desktop1280×900/mobile390×844 direct/reload + history/query/hash + panes/draft/storage/theme/shared SSE + Login + OAuth.
- All 14 route/viewport pairs match visible control/heading/image text, rounded CSS geometry, colors, font and border radius. There is no horizontal document overflow. 28 internal screenshots are retained for inspection; this is not a pixel-diff assertion or a physical mobile-device test.
- Actual same-document Link click, browser back/forward and raw History push/replace work; the settings tab follows a changed fragment.
- Two restored desktop panes remain after navigation/reload, an unsent Home draft survives remounting, localStorage/sessionStorage sentinels and dark theme survive, and exactly one active `/api/bots/events` source remains shared within the tab.
- Login removes the fragment before exactly one fixture-token POST and preserves destination query/hash. A highlighted, non-account-managed fake provider exercises the actual provider UI: popup, manual callback payload/sessionId and SSE `done` → login-complete status. No real OAuth provider, credentials, SDK call or billed generation is used.
- **211 Vitest tests in 12 files pass**, including startup races, actual AppShell writers, TaskPanes context/host, shared hub, Login, provider OAuth and Room regressions. SPA typecheck and fresh production builds pass.

Corrections found while exercising these contracts:

1. **Room member catalog race**: when SSE arrived before the initial Room GET, the Room-version guard discarded the independent Bot catalog too. Next/SPA scheduling exposed a 34px header difference and missing avatars. `RoomView.load()` now admits current-id Bot metadata before rejecting the stale Room snapshot. A deferred-GET/SSE test verifies both member availability and retention of the newer Room name.
2. **Hash observers**: History push/replace notified React's location store but not existing SettingsView hashchange listeners. The adapter now dispatches a HashChangeEvent only when the fragment actually changes, retaining oldURL/newURL. Native and browser tab-selection checks cover the bridge.
3. **Image placeholder style**: the mobile Next image sets transparent text color for its alt placeholder. The native adapter preserves that default alongside dimensions, loading mode, fill and caller style overrides; a regression test and browser comparison cover it.

Reproducible evidence from the verified run: `%LOCALAPPDATA%/Temp/leafcode-spa-browser-turn2/state.json` (`passed`,18 checks), `run-state.json` (exit0), `next-build.log`, `next-runtime.log`, and internal paired PNGs. Running services and unrelated Backend/Goal Loop/provider-overload differences are untouched. P2 remains in progress until the explicit outstanding acceptance above is resolved.

## Increment 3 — secret-canary artifact and browser boundary

`npm run test:spa:secrets` in `web/` runs 16 Node scanner/environment/response-lifetime tests and 11 Vite boundary tests. `npm run test:spa:browser` now includes the full-app canary audit in addition to increment 2's 18 contracts.

The audit uses **17 unique random dummy values**: 9 process environment values (`VITE_*`, `NEXT_PUBLIC_SECRET`, WebUI/Backend token names and OpenAI/Anthropic/Gemini key names), plus independent values in `.env`, `.env.local`, `.env.production` and `.env.production.local`. Both per-layer keys and four precedence values are injected into a private temporary env directory. `loadEnv` assertions prove that inputs are present and production-local precedence is exercised. During canary builds inherited custom environment variables are removed, only OS execution variables are retained, and the original environment is restored even on failure. No real secret is read from credential stores, used for authorization, or written into evidence.

Two full Vite builds are audited:

- The unchanged production entry/config: **29 output files, 0 source maps**.
- An additional audit build: **36 output files, including 7 source maps**. A test-only virtual import in the entry forces whole-object `import.meta.env`, each named `import.meta.env.*` and each named `process.env.*` access to remain reachable. This plugin is supplied only by the test harness and is absent from the normal production config.

All output files (HTML, main/lazy JS, CSS, source maps and public binary assets) and filenames are scanned for raw, base64/base64url, lowercase hex and escaped Unicode/JavaScript canaries. A negative test deliberately restores `envPrefix: ['VITE_']` and verifies that the detector fails. Other negative tests cover leaks in HTML/lazy bundles/maps/images, encoded values, headers and response bodies, plus empty/partial artifact directories; an empty scan cannot falsely pass. Failure messages identify input name/source and sink without echoing the value.

Verified in Chromium **153.0.8010.12**: **20 contracts pass**, preserving all previous desktop/mobile/history/panes/Login/OAuth comparisons. Across seven audit routes the env probe contains only Vite's five built-ins (`BASE_URL`, `DEV`, `MODE`, `PROD`, `SSR`); all named custom/owner values are undefined. DOM/form values, localStorage/sessionStorage, cookies, console text, outgoing request URL/headers/body, incoming response headers, **3,189 completed non-SSE response bodies**, the OAuth popup and owner fixture request log contain no canaries. Direct `.env*` and `/@fs/` requests do not disclose the injected files. SSE bodies are deliberately not buffered, and cancelled/incomplete bodies are not claimed as audited; static artifact and outgoing-request checks remain in place.

The new response audit initially exposed test-harness lifecycle mistakes: waiting for body completion on the earlier response event could hang after reload, seeded storage was accessed on opaque `about:blank`, and an OAuth popup could close before its body inspection finished. The audit now reads bodies only after `requestfinished`, never buffers SSE, seeds only actual top-level HTTP pages, and flushes completed popup responses before close. Node regressions cover unfinished/cancelled bodies and SSE; unreadable completed bodies fail rather than being silently ignored. The final run has no page/audit errors, exits 0 and closes all three SPA/audit/Next listener ports.

Current regression result: **212 Vitest tests in 12 files + 16 Node tests pass**; SPA typecheck and fresh default/audit Vite plus isolated Next production builds pass. Evidence: `%LOCALAPPDATA%/Temp/leafcode-spa-browser-turn3/state.json` (`passed`,20 checks,29/36 artifacts,3,189 audited responses), `run-state.json` (exit0), build/runtime logs and 28 internal paired screenshots. Only finite dummy-input leakage is asserted: this does not certify arbitrary API payloads, arbitrary transformations/encodings, physical-device parity or real provider OAuth. Saved-setting admission and existing UI sources remain unchanged; P2 is still in progress for the remaining acceptance above.

An additional whole-legacy-tree `npx --no-install tsc --noEmit --incremental false` check **fails** in paths outside this increment: Backend `@/lib/session-history-page` resolution, legacy layout/health/host-probe test signatures, and SDK/SQLite/typebox-related test dependencies/types. None of the reported diagnostics target this increment's changed paths. These are not repaired or claimed as passing here. The isolated Next comparison explicitly disables its typecheck; only `npm run typecheck:spa` is the passing application typecheck evidence.

## Increment 4 — server display bootstrap and metadata parity

`/webui-bootstrap.json` is a new public, read-only **presentation resource**, not a business API route. Next's route and the independent gateway share `shared/webui-presentation.mjs`, returning exactly `hostname` and `authFileDisplayPath`. These are the OS hostname and the same display-only `webui-auth.json` path already exposed by the old root/login layouts. It performs no filesystem reads, SDK calls or Host/Backend operations. GET/HEAD/OPTIONS are supported; other methods return 405. Responses are no-store/nosniff, without CORS permission, credential fields or private exception text. Only the exact resource is public; siblings and protected APIs remain gated. Non-API query-token removal/canonical redirects retain the existing policy.

This deliberately leaves the frozen P0 business API inventory unchanged (**165 routes / 265 operations**). The generated gateway includes the presentation reader and display helper (**251 runtime modules**, production graph/typecheck passes). All Next entry discovery additionally includes the non-API resource (**166 route entries**). The OS capability gate permits only the exact presentation module's static named `hostname` import, not general Node/owner access. A negative SPA build rejects accidental runtime imports of that server reader. Both Vite dev and preview proxy the exact resource, including queries, to the server-only API origin.

`Application.tsx` and `presentation.ts` replace the former browser-hostname/generic-path assumptions:

- One no-store same-origin request is shared/cached per document, with a 5s abort signal; malformed/expanded DTOs and HTTP/network failures are rejected without private error display. Failure clears the pending promise for retry. Remounts share in-flight/successful data; obsolete component updates and reset-era responses cannot overwrite a newer result.
- Protected lazy UI/default writers mount only after display information **and** the existing saved-settings gate succeed. Metadata failure shows an explicit retry screen; it never falls back to a browser hostname or a local/SDK settings reader.
- Login remains mounted independently of metadata arrival, so fragment removal/sign-in/destination are not delayed. Its temporary generic filename is replaced by the escaped server display path without resetting typed input or resubmitting the fragment. The title and badge use the actual server hostname, not the browser's URL host.
- A layout effect establishes the base title before Sidebar's passive unread-title effect. The real comparison exposed another existing race: Next's later streamed title could erase Sidebar's unread count. Sidebar now observes head/title updates, reapplies the current count only when needed and disconnects/restores the base on cleanup. Existing unread/working count tests now also replace streamed title text/nodes; no component layout/CSS/assets are redesigned.

The browser reference no longer rewrites `hostname()` or the Login display path. It uses the original root/login source, the same private test data-dir override and actual process hostname. Comparison now includes **raw document titles (including unread prefixes), hostname title-bearing spans and auth-file code text**, alongside existing geometry/style controls. All **14 desktop/mobile route pairs** match, including direct/reload and no horizontal overflow.

**23 production browser contracts pass** in Chromium153.0.8010.12: the previous20 plus metadata503/retry with no pre-admission settings traffic; a held metadata request while Login removes/posts its fragment exactly once and retains destination query/hash; and settings401 after public metadata, redirecting to Login with the exact destination and no protected Bot tree. Existing panes/drafts/storage/theme/shared SSE and fake OAuth contracts remain passing. All17 secret canaries remain absent from default/audit artifacts and browser sinks (**3,392 completed pre-disposal response bodies**); source-map audit remains test-only. Response audit capture now ends before context disposal so late closing-target completions are not falsely read after their target disappears; an additional Node regression verifies this cutoff, while unreadable bodies captured before it still fail.

Verification: **275 Vitest tests / 16 files pass**; **33 distinct Node tests pass** across gateway auth/HTTP/presentation/graph and the canary helper (32 combined tests before the cutoff regression, then all17 canary tests after it). Auth matches the Next proxy over528 observations; compression matches over347. SPA typecheck, production gateway build and API/transport/all-entry ownership gates pass. Fresh default/audit Vite and isolated Next builds and all23 browser contracts exit0. All three SPA/audit/Next listener ports are closed; no running service, real credential or billed operation is used.

Evidence: `%LOCALAPPDATA%/Temp/leafcode-spa-browser-turn4/state.json` (`passed`,23 checks,3,392 audited bodies,no errors), `run-state.json` (exit0), paired internal screenshots and build/runtime logs. These finite fixtures are not proof of real notification delivery, physical-device touch, every UI state, real provider OAuth or a successful whole-legacy-tree typecheck. P2 continues with the explicit remaining acceptance above.

## Increment 5 — notification producers, shared SSE and saved OFF state

`scripts/spa-notification-contract.mjs` adds notification contracts to the existing production browser runner without changing the application UI or notification policy. Each Next/SPA desktop1280×900/mobile390×844 comparison runs real HTTP EventSource streams and the actual TaskView, BotView, RoomView and BotRoutineNotifier. A wrapper forwards constructor calls to Chromium's **native Notification** with context-scoped permission granted, captures title/body/tag/native permission and immediately closes the test notification. Document visibility and default/denied permission states are explicitly controlled; permission request results are simulated. This is a browser producer/API-boundary assertion, **not** a native OS toast, real permission dialog, speaker, physical-device backgrounding or external Pushover delivery test.

Contracts cover:

- Hidden Task completion and approval rising edges, repeated-snapshot duplicate suppression, foreground completion suppression and denied permission. Bot and Room completion/approval edges preserve their original title/body/tag. Inline Bot routine handling suppresses the global subscriber; off-route routine delivery, visible suppression and exactly one default-permission request per document remain intact. Captured records for all four producers are compared between Next and SPA.
- Actual desktop/mobile footer clicks issue the existing `/api/notifications` PUT and persist OFF/ON in the fixture's saved settings. OFF remains effective across same-document Settings navigation and hard reload; ON resumes delivery without replaying an old edge. A server-ended shared SSE connection reconnects to exactly one source; entering Login removes the protected subscribers/source, then returning remounts one source and emits exactly one notification for the new routine.
- A held `/api/settings` prevents notification status requests, individual setting writers and all EventSources from starting. After release, saved global OFF and sound-volume0 override stale local volume100 before producers run, **even while the independent footer status GET is still held**. Reconciliation may write the same saved custom sound values, never pre-hydration defaults.

The finite fixture now provides `/api/bots/sidebar` and `/api/notifications`, mutable per-instance saved settings, targeted SSE injection/disconnect and latest-snapshot replay. Its state resets between cases without mutating exported reference seeds. Three Node regressions verify OFF persistence, invalid boolean rejection, setting/sound write isolation and reset, sidebar mute metadata, stream targeting and reconnect replay. The isolated Next reference obtains its SSR settings from the same no-store fixture GET per render instead of a compile-time constant, so ON/OFF cases compare matching server inputs.

Initial failures were **harness gaps, not production notification regressions**: missing sidebar metadata correctly made routine delivery fail closed; the mobile drawer had to be opened to mount its footer; a pending desktop footer is not a missing mobile menu; and its overlay/header close buttons share a label, requiring dialog-scoped targeting. Tests now use actual menu/close clicks and await loaded footer state. The expanded multi-document producer comparison also exposed Chromium discarding old-document completed-body handles on navigation. Page goto/reload now drain captured completed responses before navigating; a new Node regression verifies body readability before this boundary. Unreadable completed bodies still fail; no audit error is silently dropped. Production notification implementations, components, CSS/assets, API ownership and running services are unchanged.

Final verification: **33 production browser contracts pass** (previous23 +10 notification/lifecycle/admission contracts), all14 seven-route desktop/mobile pairs still match without hostname/path/title normalization, and all17 secret canaries are absent from default/audit artifacts, notification records and browser sinks (**4,828 completed response bodies**, no page/audit errors). Default/audit builds retain29/36 files and0/7 source maps. **409 Vitest tests / 24 distinct files pass** in two selections (244 notification/SPA tests +165 shell/panes/Login/provider/display regressions). **21 Node tests pass** (18 canary/helper +3 fixture tests). SPA typecheck and API/all-Next-entry ownership gates pass; the frozen165/265 API inventory is unchanged. Fresh Vite/default/audit and isolated Next production builds and the browser runner exit0. All SPA/audit/Next listener ports are closed, no actual service or agent is restarted, and no real credential/billed operation is used.

Evidence: `%LOCALAPPDATA%/Temp/leafcode-spa-browser-turn5/state.json` (`passed`,33 checks,4,828 audited bodies,4 producer-record sets,no errors), `run-state.json` (exit0), build/runtime logs and28 internal paired screenshots. Browser visibility/default-permission controls, finite negative settling windows and private fixture state are explicit limitations. Next's reference still disables the known whole-legacy-tree typecheck; SPA typecheck is the passing application type evidence. The next P2 unit is the remaining actual pane/tab/mobile interaction comparison rather than a claim that every UI/provider/platform state is already proven.
