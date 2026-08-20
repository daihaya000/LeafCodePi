import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("collectSystemUsageCached", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("LEAFCODE_SYSMON_USAGE_CACHE_MS", "60000");
    vi.stubEnv("LEAFCODE_SYSMON_GPU_CACHE_MS", "0");
    vi.stubEnv("LEAFCODE_SYSMON_NVIDIA_SMI", "__leafcode_missing_nvidia_smi__");
    vi.stubEnv("LEAFCODE_SYSMON_POWERSHELL", "__leafcode_missing_powershell__");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the same cached snapshot within TTL", async () => {
    const mod = await import("./sysmon-usage");
    mod.resetSystemUsageCacheForTests();

    const first = await mod.collectSystemUsageCached();
    const t0 = Date.now();
    const second = await mod.collectSystemUsageCached();
    const elapsed = Date.now() - t0;

    expect(first.available).toBe(true);
    expect(second).toBe(first);
    expect(elapsed).toBeLessThan(25);
  });

  it("coalesces concurrent first loads", async () => {
    const mod = await import("./sysmon-usage");
    mod.resetSystemUsageCacheForTests();

    const [a, b] = await Promise.all([
      mod.collectSystemUsageCached(),
      mod.collectSystemUsageCached(),
    ]);
    expect(a).toBe(b);
  });
});
