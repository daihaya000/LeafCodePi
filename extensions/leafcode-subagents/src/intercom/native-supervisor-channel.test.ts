import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
let root = "";
let mod: typeof import("./native-supervisor-channel.ts");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "supervisor-channel-listing-"));
  roots.push(root);
  vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", root);
  mod = await import("./native-supervisor-channel.ts");
}, 30_000);

afterAll(() => {
  vi.unstubAllEnvs();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("supervisor channel request listing", () => {
  it("refreshes the request listing after cache invalidation", () => {
    const channelDir = mod.resolveSupervisorChannelDir("run-listing", "worker", 0);
    mod.ensureSupervisorChannelDir(channelDir);
    const requestsDir = join(channelDir, "requests");
    mod.__resetSupervisorRequestListingCacheForTests();

    expect(mod.listSupervisorRequestFiles()).toEqual([]);

    writeFileSync(join(requestsDir, "a.json"), "{}", "utf8");
    mod.__resetSupervisorRequestListingCacheForTests();
    const afterWrite = mod.listSupervisorRequestFiles();
    expect(afterWrite.map((item) => item.file)).toEqual([join(requestsDir, "a.json")]);

    writeFileSync(join(requestsDir, "b.json"), "{}", "utf8");
    mod.__resetSupervisorRequestListingCacheForTests();
    expect(mod.listSupervisorRequestFiles().map((item) => item.file)).toEqual([
      join(requestsDir, "a.json"),
      join(requestsDir, "b.json"),
    ]);
  });

  it("bounds root and request-directory scans while discovering new requests within one second", () => {
    const existingChannelDir = mod.resolveSupervisorChannelDir("run-root-refresh-existing", "worker", 0);
    const newChannelDir = mod.resolveSupervisorChannelDir("run-root-refresh-new", "worker", 0);
    const newRequestsDir = join(newChannelDir, "requests");
    mod.ensureSupervisorChannelDir(existingChannelDir);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      mod.__resetSupervisorRequestListingCacheForTests();
      expect(mod.listSupervisorRequestFiles().some((item) => item.channelDir === newChannelDir)).toBe(false);
      const initialProbes = mod.__getSupervisorListingProbeCountsForTests();
      expect(initialProbes.rootListingReads).toBe(1);
      expect(initialProbes.requestDirectoryListingReads).toBeGreaterThan(0);

      mod.ensureSupervisorChannelDir(newChannelDir);
      writeFileSync(join(newRequestsDir, "a.json"), "{}", "utf8");
      expect(mod.listSupervisorRequestFiles().some((item) => item.channelDir === newChannelDir)).toBe(false);
      expect(mod.__getSupervisorListingProbeCountsForTests()).toEqual(initialProbes);

      vi.setSystemTime(new Date(1_000_751));
      expect(mod.listSupervisorRequestFiles().some((item) => item.channelDir === newChannelDir)).toBe(true);
      const refreshedProbes = mod.__getSupervisorListingProbeCountsForTests();
      expect(refreshedProbes.rootListingReads).toBe(initialProbes.rootListingReads + 1);
      expect(refreshedProbes.requestDirectoryListingReads).toBeGreaterThan(initialProbes.requestDirectoryListingReads);
    } finally {
      vi.useRealTimers();
      mod.__resetSupervisorRequestListingCacheForTests();
    }
  });

  it("forgets channels that no longer exist", () => {
    const channelDir = mod.resolveSupervisorChannelDir("run-dropping", "worker", 0);
    mod.ensureSupervisorChannelDir(channelDir);
    writeFileSync(join(channelDir, "requests", "a.json"), "{}", "utf8");
    mod.__resetSupervisorRequestListingCacheForTests();
    expect(mod.listSupervisorRequestFiles().some((item) => item.channelDir === channelDir)).toBe(true);

    rmSync(channelDir, { recursive: true, force: true });
    mod.__resetSupervisorRequestListingCacheForTests();
    expect(mod.listSupervisorRequestFiles().some((item) => item.channelDir === channelDir)).toBe(false);
  });
});
