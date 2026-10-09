export function overrideSessionAutoRetry(session: {
  settingsManager?: { applyOverrides(overrides: { retry: { enabled: boolean } }): void };
}, enabled: boolean): boolean;
