import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let probes = 0;

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  probes = 0;
  vi.stubEnv("LEAFCODE_SYSMON_USAGE_CACHE_MS", "0");
  vi.stubEnv("LEAFCODE_SYSMON_GPU_CACHE_MS", "0");
  vi.stubEnv("LEAFCODE_SYSMON_NVIDIA_SMI", "__leafcode_missing_nvidia_smi__");
  vi.stubEnv("LEAFCODE_SYSMON_POWERSHELL", "__leafcode_missing_powershell__");
  vi.stubEnv("LEAFCODE_SYSMON_TEMPERATURE_CACHE_MS", "60000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CPU temperature probe caching", () => {
  it("runs the probe once inside the TTL and reuses the value", async () => {
    const mod = await import("./sysmon-usage");
    mod.resetSystemUsageCacheForTests();
    mod.setCpuTemperatureProbeForTests(async () => {
      probes += 1;
      return 55;
    });

    expect((await mod.collectSystemUsage()).cpu.tempC).toBe(55);
    expect((await mod.collectSystemUsage()).cpu.tempC).toBe(55);
    expect((await mod.collectSystemUsage()).cpu.tempC).toBe(55);
    expect(probes).toBe(1);
  });

  it("coalesces concurrent probes into one run", async () => {
    const mod = await import("./sysmon-usage");
    mod.resetSystemUsageCacheForTests();
    mod.setCpuTemperatureProbeForTests(async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 60;
    });

    const values = await Promise.all([
      mod.collectSystemUsage(),
      mod.collectSystemUsage(),
      mod.collectSystemUsage(),
    ]);

    expect(values.map((usage) => usage.cpu.tempC)).toEqual([60, 60, 60]);
    expect(probes).toBe(1);
  });

  it("does not pin a failed probe for the whole TTL", async () => {
    const mod = await import("./sysmon-usage");
    mod.resetSystemUsageCacheForTests();
    mod.setCpuTemperatureProbeForTests(async () => {
      probes += 1;
      return probes === 1 ? null : 45;
    });

    expect((await mod.collectSystemUsage()).cpu.tempC).toBeNull();
    expect((await mod.collectSystemUsage()).cpu.tempC).toBe(45);
    expect(probes).toBe(2);
  });

  it("re-probes once the TTL expires", async () => {
    vi.stubEnv("LEAFCODE_SYSMON_TEMPERATURE_CACHE_MS", "0");
    const mod = await import("./sysmon-usage");
    mod.resetSystemUsageCacheForTests();
    mod.setCpuTemperatureProbeForTests(async () => {
      probes += 1;
      return probes;
    });

    expect((await mod.collectSystemUsage()).cpu.tempC).toBe(1);
    expect((await mod.collectSystemUsage()).cpu.tempC).toBe(2);
    expect(probes).toBe(2);
  });
});