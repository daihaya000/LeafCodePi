export function sessionLocalSettingsManager<T extends {
  applyOverrides(overrides: { retry?: { enabled: boolean }; compaction?: { enabled: boolean } }): void;
  getCacheWarmingMode(): string;
  reload(): Promise<void>;
}>(manager: T): T;
