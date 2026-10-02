import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { OPENAI_FAST_MODE_SETTING_KEY } from "@/lib/openai-fast-mode";
import { setSetting } from "./web-settings";
import { sessionExtensionFactories } from "./harness";

// Explicit opt-in: real requests consume the selected account's allowance.
const accountId = process.env.LEAFCODE_FAST_LIVE_ACCOUNT_ID;
const modelId = process.env.LEAFCODE_FAST_LIVE_MODEL ?? "gpt-5.5";
// Vitest deliberately replaces APPDATA/LEAFCODE_PI_DATA_DIR with test-only paths.
// Require a separate, explicit live metadata directory; never defeat that sandbox.
const liveDataDir = process.env.LEAFCODE_FAST_LIVE_DATA_DIR;
const liveAgentDir = process.env.LEAFCODE_FAST_LIVE_AGENT_DIR ?? join(homedir(), ".pi", "agent");

it.skipIf(!accountId).each(["sse", "websocket"] as const)("accepts Codex Fast on a registered account via %s", async (transport) => {
  if (!accountId || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(accountId)) {
    throw new Error("LEAFCODE_FAST_LIVE_ACCOUNT_ID must be an enabled registered account UUID");
  }
  if (!liveDataDir) throw new Error("LEAFCODE_FAST_LIVE_DATA_DIR is required for opt-in live tests");
  const accounts = JSON.parse(readFileSync(join(liveDataDir, "accounts.json"), "utf8")) as {
    accounts: Array<{ id: string; enabled: boolean; providers: string[] }>;
  };
  expect(accounts.accounts.some((account) => account.id === accountId && account.enabled && account.providers.includes("openai-codex"))).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "leafcode-fast-live-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(liveAgentDir, "accounts", accountId, "auth.json"), modelsPath: null, refreshOnCreate: false,
    });
    const model = runtime.getModel("openai-codex", modelId);
    if (!model) throw new Error("Selected Codex model is not in the SDK catalog");
    const sent: unknown[] = [];
    const completionTiers: unknown[] = [];
    const hookErrors: string[] = [];
    const settingsManager = SettingsManager.inMemory({ transport, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        ...sessionExtensionFactories({ agentDir: root, hasBotSkills: false, getExtensions: () => [] }).slice(0, 1),
        (extension) => {
          extension.on("before_provider_request", (event) => {
            sent.push((event.payload as { service_tier?: unknown }).service_tier ?? null);
          });
          extension.on("provider_stream_event", (event) => {
            const data = event.data as { type?: string; response?: { service_tier?: unknown } };
            if (data.type === "response.completed") completionTiers.push(data.response?.service_tier ?? null);
          });
        },
      ],
    });
    await loader.reload();
    session = (await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.inMemory(root), modelRuntime: runtime, model, thinkingLevel: "off", tools: [],
    })).session;
    await session.bindExtensions({ onError: (error) => hookErrors.push(error.error) });
    deadline = setTimeout(() => { void session?.abort(); }, 18_000);
    for (const enabled of [false, true]) {
      sent.length = 0;
      completionTiers.length = 0;
      setSetting(OPENAI_FAST_MODE_SETTING_KEY, enabled ? "1" : null);
      await session.prompt("Reply only: OK");
      const message = session.messages.at(-1) as { role?: string; stopReason?: string };
      console.log("FAST_LIVE", JSON.stringify({ model: modelId, transport, fast: enabled, sent, completionTiers, stop: message.stopReason }));
      expect(message).toMatchObject({ role: "assistant", stopReason: "stop" });
      expect(sent).toEqual([enabled ? "priority" : null]);
      expect(completionTiers).toHaveLength(1);
      // Codex OAuth reports default even on Fast: do NOT demand response tier=priority.
      // https://github.com/openai/codex/issues/14204#issuecomment-4033184620
      expect(hookErrors).toEqual([]);
    }
  } finally {
    if (deadline) clearTimeout(deadline);
    session?.dispose();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 22_000);
