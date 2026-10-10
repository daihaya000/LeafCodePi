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
- Notification delivery and additional persistence/remount cases; the fixture below covers actual panes/drafts/storage/theme/shared SSE across navigation and reload.
- Additional provider-specific OAuth flows beyond the fixture's generic popup/manual relay/SSE completion contract.
- Exact server-layout metadata parity: SPA currently uses an HTML `LCP` title, browser hostname badge and a generic `webui-auth.json` login path rather than server hostname/display path. These are explicit outstanding parity differences, not verified equivalents.
- Production artifact/browser canary inspection beyond the fixture; source import conversion/final legacy-framework removal and build-warning/chunk review.
- The `use client` directives are intentionally retained in reused files and emit ignored-directive warnings during the Vite build; ProtectedApp also exceeds the chunk-size warning threshold. Build success does not claim performance/visual parity.

## Increment 2 — real-browser contracts and race corrections

`npm run test:spa:browser` in `web/` runs `scripts/spa-browser-contract.mjs`. Playwright 1.62.1 is a dev dependency only. Install its Chromium beforehand (`npx --no-install playwright install chromium`), or explicitly select an existing compatible browser using `LEAFCODE_TEST_CHROMIUM`. Evidence defaults to a temporary directory; `LEAFCODE_SPA_EVIDENCE_DIR` selects a private test output directory.

The harness builds both production Vite and an isolated production Next reference, uses ephemeral loopback ports and a finite API/SSE fixture, and blocks browser traffic outside those origins. Next's app layout receives the same controlled settings snapshot. Reference hostname/login display path are normalized to the SPA's current values: this deliberately excludes the outstanding metadata differences above. The reference reuses the current presentation sources (including the Room race fix), not a frozen historical UI archive. Unknown/nonessential owner endpoints return explicit fixture 503 responses; this is not a fully operational SDK/Host simulation.

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
