import { useMemo, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let installed = false;
const emit = () => { for (const listener of listeners) listener(); };
export function installNavigation(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
      const oldURL = window.location.href, oldHash = window.location.hash;
      original(data, unused, url);
      emit();
      // Existing SettingsView observes native hashchange, not the router store.
      if (oldHash !== window.location.hash) window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href }));
    };
  }
  window.addEventListener("popstate", emit);
  window.addEventListener("hashchange", emit);
}
function subscribe(listener: () => void) { installNavigation(); listeners.add(listener); return () => { listeners.delete(listener); }; }
function locationSnapshot() { return window.location.pathname + window.location.search + window.location.hash; }
export function useLocation() { return useSyncExternalStore(subscribe, locationSnapshot, () => "/"); }
export function usePathname(): string { return useLocation().split(/[?#]/, 1)[0]; }
export function useSearchParams(): URLSearchParams {
  const location = useLocation();
  return useMemo(() => new URL(location, window.location.origin).searchParams, [location]);
}
export function routeParams(path: string): Record<string, string> {
  const bot = /^\/bots\/([^/]+)$/.exec(path), room = /^\/bots\/rooms\/([^/]+)$/.exec(path), task = /^\/task\/([^/]+)$/.exec(path);
  try { return room ? { roomId: decodeURIComponent(room[1]) } : bot ? { id: decodeURIComponent(bot[1]) } : task ? { id: decodeURIComponent(task[1]) } : {}; } catch { return {}; }
}
export function useParams<T = Record<string, string>>(): T { const pathname = usePathname(); return useMemo(() => routeParams(pathname) as T, [pathname]); }
function navigate(href: string, replace: boolean, options?: { scroll?: boolean }) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Navigation must stay on this origin");
  installNavigation(); window.history[replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search + url.hash);
  if (options?.scroll !== false) {
    if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
    else window.scrollTo({ top: 0 });
  }
}
const router = {
  push: (href: string, options?: { scroll?: boolean }) => navigate(href, false, options),
  replace: (href: string, options?: { scroll?: boolean }) => navigate(href, true, options),
  back: () => window.history.back(), forward: () => window.history.forward(),
  refresh: () => emit(), prefetch: (_href: string) => {},
};
export function useRouter() { return router; }
