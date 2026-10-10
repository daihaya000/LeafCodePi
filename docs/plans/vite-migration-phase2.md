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

- Real desktop/mobile browser comparison of visuals, navigation/back/forward/reload and pointer interactions.
- Actual TaskPanes tab/pane restoration under the SPA adapters, drafts/storage/theme/notifications/shared SSE lifetime across navigation/remounts.
- Provider OAuth popup/callback/destination checks without real credentials or billed execution.
- Exact server-layout metadata parity: SPA currently uses an HTML `LCP` title, browser hostname badge and a generic `webui-auth.json` login path rather than server hostname/display path. These are explicit outstanding parity differences, not verified equivalents.
- Production artifact/browser canary inspection beyond the fixture; source import conversion/final legacy-framework removal and build-warning/chunk review.
- The `use client` directives are intentionally retained in reused files and emit ignored-directive warnings during the Vite build; ProtectedApp also exceeds the chunk-size warning threshold. Build success does not claim performance/visual parity.
