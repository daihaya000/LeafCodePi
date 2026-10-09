/**
 * The host persists shared policy once; live SDK setters only synchronize the
 * session. SDK persistent setters also rebuild effective settings from disk
 * snapshots, dropping unrelated runtime overrides (retry/compaction).
 */
export function sessionLocalSettingsManager(manager) {
  let cacheWarmingMode;
  let cacheWarmingRevision = 0;
  return new Proxy(manager, {
    get(target, property) {
      if (property === "setRetryEnabled") {
        return (enabled) => target.applyOverrides({ retry: { enabled } });
      }
      if (property === "setCompactionEnabled") {
        return (enabled) => target.applyOverrides({ compaction: { enabled } });
      }
      // SDK intentionally reads cache warming from globalSettings, not from
      // applyOverrides. Keep a local policy getter while retaining the SDK's
      // setCacheWarmingMode -> CacheWarmer.onModeChanged notification path.
      if (property === "getCacheWarmingMode") {
        return () => cacheWarmingMode ?? target.getCacheWarmingMode();
      }
      if (property === "setCacheWarmingMode") {
        return (mode) => { cacheWarmingMode = mode; cacheWarmingRevision += 1; };
      }
      if (property === "reload") {
        return async (...args) => {
          const revision = cacheWarmingRevision;
          await target.reload(...args);
          if (revision === cacheWarmingRevision) cacheWarmingMode = undefined;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
