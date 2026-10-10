/** Serializable Playwright init script: never reseed saved state on navigation. */
export function seedMissingBrowserSettings(seed) {
  // about:blank and child frames may have opaque/foreign storage origins.
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  for (const [key, value] of Object.entries(seed)) {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
}
