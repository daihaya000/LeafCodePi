import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { sessionLocalSettingsManager } from "@backend-core/session-local-settings.mjs";

it("live SDK policy setters preserve temporary overrides and never write shared policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-local-settings-"));
  const persisted = SettingsManager.create(root, root);
  const local = sessionLocalSettingsManager(SettingsManager.create(root, root));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: local,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: local,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(root), modelRuntime, model: faux.getModel(), tools: [] }));
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    local.applyOverrides({ compaction: { enabled: true, reserveTokens: 7000 }, retry: { enabled: false } });
    session.setAutoCompactionEnabled(false);
    expect(local.getRetryEnabled()).toBe(false);
    expect(local.getCompactionSettings()).toMatchObject({ enabled: false, reserveTokens: 7000 });
    session.setCacheWarmingMode("off");
    expect(local.getCacheWarmingMode()).toBe("off");
    expect(local.getCompactionSettings()).toMatchObject({ enabled: false, reserveTokens: 7000 });
    expect(local.getRetryEnabled()).toBe(false);
    session.setAutoRetryEnabled(true);
    expect(local.getRetryEnabled()).toBe(true);
    expect(local.getCacheWarmingMode()).toBe("off");
    await local.flush();
    expect(local.getGlobalSettings()).toEqual({});
    expect(SettingsManager.create(root, root).getGlobalSettings()).toEqual({});
    // A durable change is owned by the host, once. Runtime reload observes it.
    persisted.setCacheWarmingMode("streaming");
    await persisted.flush();
    await session.reload();
    expect(local.getCacheWarmingMode()).toBe("streaming");
    expect(local.getRetryEnabled()).toBe(true);
  } finally {
    session?.dispose();
    await persisted.flush();
    rmSync(root, { recursive: true, force: true });
  }
});

it("reload cannot erase a newer in-flight warming change", async () => {
  let resolve!: () => void;
  const manager = {
    applyOverrides() {}, getCacheWarmingMode: () => "streaming",
    setCacheWarmingMode: (_mode: string) => { throw new Error("persistent setter called"); },
    reload: () => new Promise<void>((done) => { resolve = done; }),
  };
  const local = sessionLocalSettingsManager(manager);
  local.setCacheWarmingMode("off");
  const reloading = local.reload();
  local.setCacheWarmingMode("all");
  resolve();
  await reloading;
  expect(local.getCacheWarmingMode()).toBe("all");
});

it("failed reload preserves the live warming policy", async () => {
  const local = sessionLocalSettingsManager({
    applyOverrides() {}, getCacheWarmingMode: () => "streaming",
    setCacheWarmingMode: (_mode: string) => { throw new Error("persistent setter called"); },
    reload: async () => { throw new Error("reload failed"); },
  });
  local.setCacheWarmingMode("off");
  await expect(local.reload()).rejects.toThrow("reload failed");
  expect(local.getCacheWarmingMode()).toBe("off");
});
