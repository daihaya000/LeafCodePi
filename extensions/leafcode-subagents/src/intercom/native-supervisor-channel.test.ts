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
  it("reuses the cached listing while the requests directory is unchanged", () => {
    const channelDir = mod.resolveSupervisorChannelDir("run-listing", "worker", 0);
    mod.ensureSupervisorChannelDir(channelDir);
    const requestsDir = join(channelDir, "requests");
    mod.__resetSupervisorRequestListingCacheForTests();

    expect(mod.listSupervisorRequestFiles()).toEqual([]);

    writeFileSync(join(requestsDir, "a.json"), "{}", "utf8");
    const afterWrite = mod.listSupervisorRequestFiles();
    expect(afterWrite.map((item) => item.file)).toEqual([join(requestsDir, "a.json")]);

    writeFileSync(join(requestsDir, "b.json"), "{}", "utf8");
    expect(mod.listSupervisorRequestFiles().map((item) => item.file)).toEqual([
      join(requestsDir, "a.json"),
      join(requestsDir, "b.json"),
    ]);
  });

  it("forgets channels that no longer exist", () => {
    const channelDir = mod.resolveSupervisorChannelDir("run-dropping", "worker", 0);
    mod.ensureSupervisorChannelDir(channelDir);
    writeFileSync(join(channelDir, "requests", "a.json"), "{}", "utf8");
    mod.__resetSupervisorRequestListingCacheForTests();
    expect(mod.listSupervisorRequestFiles().some((item) => item.channelDir === channelDir)).toBe(true);

    rmSync(channelDir, { recursive: true, force: true });
    expect(mod.listSupervisorRequestFiles().some((item) => item.channelDir === channelDir)).toBe(false);
  });
});