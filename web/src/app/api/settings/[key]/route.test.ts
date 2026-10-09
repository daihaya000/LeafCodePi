import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
const accounts = vi.hoisted(() => ({ listAccounts: vi.fn() }));
const harness = vi.hoisted(() => ({
  refreshCompactionSuggestions: vi.fn(),
  applyCodePermissionSettingsToLiveTasks: vi.fn(async () => undefined),
}));
vi.mock("@/lib/pi/harness", () => harness);

vi.mock("@/lib/pi/web-settings", () => ({
  MAX_SETTING_VALUE_CHARS: 4096,
  getSetting: settings.getSetting,
  setSetting: settings.setSetting,
}));
vi.mock("@/lib/accounts", () => ({ listAccounts: accounts.listAccounts }));
vi.mock("@/lib/machine-name", () => ({ getMachineName: () => "x870" }));

import { GET, PUT } from "@backend-runtime/configuration/handlers/settings/[key]/route";

function request(key: string, body: unknown): NextRequest {
  return new NextRequest(`http://127.0.0.1:3010/api/settings/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/settings/[key]", () => {
  it.each(["1", "50", "1000", null])("persists the model throughput window %s", async (value) => {
    const key = "model-throughput-window";
    const response = await PUT(request(key, { value }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(key, value);
  });

  it.each(["0", "-1", "2.5", "1001", "NaN"])("rejects an invalid model throughput window %s", async (value) => {
    const key = "model-throughput-window";
    const response = await PUT(request(key, { value }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("reads the persisted model throughput window", async () => {
    const key = "model-throughput-window";
    settings.getSetting.mockReturnValue("100");
    const response = await GET(new NextRequest(`http://127.0.0.1/api/settings/${key}`), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: "100" });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    accounts.listAccounts.mockReturnValue([]);
    settings.getSetting.mockReturnValue("llama-server::local-model");
  });

  it.each([
    ["compactionAction", "suggest"],
    ["compactionAction", "off"],
    ["compactionAction", "auto"],
    ["compactionThreshold", "85"],
    ["compactionAction", null],
    ["compactionThreshold", ""],
  ])("persists %s=%s; the owner command applies suggestions", async (key, value) => {
    const response = await PUT(request(key!, { value }), {
      params: Promise.resolve({ key: key! }),
    });
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalled();
    expect(harness.refreshCompactionSuggestions).not.toHaveBeenCalled();
  });

  it.each([
    ["compaction-background-enabled", "0"],
    ["compaction-background-enabled", "1"],
    ["compaction-background-threshold", "70"],
    ["compaction-background-threshold", "85"],
    ["compaction-summary-max-tokens", "2048"],
    ["compaction-summary-max-tokens", "16384"],
    ["compaction-background-enabled", null],
  ])("accepts %s=%s for the unified compactor", async (key, value) => {
    const response = await PUT(request(key!, { value }), { params: Promise.resolve({ key: key! }) });
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(key, value);
  });

  it.each([
    ["compaction-background-enabled", "false"],
    ["compaction-background-threshold", "49"],
    ["compaction-background-threshold", "86"],
    ["compaction-background-threshold", "70.5"],
    ["compaction-summary-max-tokens", "511"],
    ["compaction-summary-max-tokens", "16385"],
    ["compaction-summary-max-tokens", "NaN"],
  ])("rejects invalid %s=%s without saving", async (key, value) => {
    const response = await PUT(request(key, { value }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it.each([
    ["code-permission-mode", "ask"],
    ["code-permission-mode", "deny"],
    ["code-skill-permission", "deny"],
    ["code-subagent-permission", "allow"],
  ])("persists %s=%s; the owner command updates open Code sessions", async (key, value) => {
    const response = await PUT(request(key, { value }), { params: Promise.resolve({ key }) });

    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(key, value);
    expect(harness.applyCodePermissionSettingsToLiveTasks).not.toHaveBeenCalled();
  });

  it.each([
    ["code-permission-mode", "always"],
    ["code-skill-permission", "ask"],
    ["code-subagent-permission", "yes"],
  ])("rejects %s=%s without touching open sessions", async (key, value) => {
    const response = await PUT(request(key, { value }), { params: Promise.resolve({ key }) });

    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
    expect(harness.applyCodePermissionSettingsToLiveTasks).not.toHaveBeenCalled();
  });

  it("accepts only valid Jev Auto routing settings", async () => {
    const enabled = await PUT(request("auto-jev-enabled", { value: "1" }), {
      params: Promise.resolve({ key: "auto-jev-enabled" }),
    });
    const confidence = await PUT(request("auto-jev-min-confidence", { value: "0.75" }), {
      params: Promise.resolve({ key: "auto-jev-min-confidence" }),
    });
    const invalidEnabled = await PUT(request("auto-jev-enabled", { value: "0" }), {
      params: Promise.resolve({ key: "auto-jev-enabled" }),
    });
    const invalidConfidence = await PUT(request("auto-jev-min-confidence", { value: "0.61" }), {
      params: Promise.resolve({ key: "auto-jev-min-confidence" }),
    });

    expect(enabled.status).toBe(200);
    expect(confidence.status).toBe(200);
    expect(invalidEnabled.status).toBe(400);
    expect(invalidConfidence.status).toBe(400);
    expect(settings.setSetting).toHaveBeenCalledWith("auto-jev-enabled", "1");
    expect(settings.setSetting).toHaveBeenCalledWith("auto-jev-min-confidence", "0.75");
  });

  it("stores only the OFF value for session label Jev", async () => {
    const key = "session-label-jev";
    const off = await PUT(request(key, { value: "0" }), { params: Promise.resolve({ key }) });
    const invalid = await PUT(request(key, { value: "1" }), { params: Promise.resolve({ key }) });
    expect(off.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(settings.setSetting).toHaveBeenCalledWith(key, "0");
  });

  it("accepts the Bot notification sound type and rejects unknown values", async () => {
    const accepted = await PUT(request("notification-sound-type-bot", { value: "soft" }), {
      params: Promise.resolve({ key: "notification-sound-type-bot" }),
    });
    const rejected = await PUT(request("notification-sound-type-bot", { value: "loud" }), {
      params: Promise.resolve({ key: "notification-sound-type-bot" }),
    });

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(settings.setSetting).toHaveBeenCalledWith("notification-sound-type-bot", "soft");
  });

  it("does not notify for rejected or unrelated settings", async () => {
    await PUT(request("compactionAction", { value: "invalid" }), {
      params: Promise.resolve({ key: "compactionAction" }),
    });
    await PUT(request("auto-show-model", { value: "1" }), {
      params: Promise.resolve({ key: "auto-show-model" }),
    });
    expect(harness.refreshCompactionSuggestions).not.toHaveBeenCalled();
  });

  it("validates the compaction model and effort", async () => {
    accounts.listAccounts.mockReturnValue([{ id: "acc-1" }]);
    const model = await PUT(request("compaction-model", { value: "acc-1::anthropic::claude-haiku" }), {
      params: Promise.resolve({ key: "compaction-model" }),
    });
    const effort = await PUT(request("compaction-model-effort", { value: "low" }), {
      params: Promise.resolve({ key: "compaction-model-effort" }),
    });
    const invalidModel = await PUT(request("compaction-model", { value: "no-model" }), {
      params: Promise.resolve({ key: "compaction-model" }),
    });
    const invalidEffort = await PUT(request("compaction-model-effort", { value: "huge" }), {
      params: Promise.resolve({ key: "compaction-model-effort" }),
    });
    const cleared = await PUT(request("compaction-model", { value: "" }), {
      params: Promise.resolve({ key: "compaction-model" }),
    });

    expect([model.status, effort.status, invalidModel.status, invalidEffort.status, cleared.status])
      .toEqual([200, 200, 400, 400, 200]);
    expect(settings.setSetting).toHaveBeenCalledWith("compaction-model", "acc-1::anthropic::claude-haiku");
    expect(settings.setSetting).toHaveBeenCalledWith("compaction-model-effort", "low");
    expect(settings.setSetting).toHaveBeenCalledWith("compaction-model", null);
  });

  it("includes the current machine name with the commit author setting", async () => {
    const key = "git-commit-author";
    const value = JSON.stringify({
      nameTemplate: "{agent}",
      emailTemplate: "{agent}@leafcodepi.{machine}",
    });
    settings.getSetting.mockReturnValue(value);

    const response = await GET(new NextRequest(`http://127.0.0.1:3010/api/settings/${key}`), {
      params: Promise.resolve({ key }),
    });

    expect(await response.json()).toEqual({ value, machineName: "x870" });
  });

  it("reads and writes the generation model", async () => {
    const getResponse = await GET(new NextRequest("http://127.0.0.1:3010/api/settings/generation-model"), {
      params: Promise.resolve({ key: "generation-model" }),
    });
    expect(await getResponse.json()).toEqual({ value: "llama-server::local-model" });

    const putResponse = await PUT(
      request("generation-model", { value: "ollama-cloud::qwen3" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(putResponse.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("generation-model", "ollama-cloud::qwen3");
  });

  it("accepts and validates Git commit author templates", async () => {
    const key = "git-commit-author";
    const payload = JSON.stringify({
      nameTemplate: "Agent ({agent})",
      emailTemplate: "{agent}@leafcodepi.{machine}",
    });
    const accepted = await PUT(request(key, { value: payload }), {
      params: Promise.resolve({ key }),
    });
    const rejected = await PUT(request(key, {
      value: JSON.stringify({ nameTemplate: "Bad\nName", emailTemplate: "bot@example.test" }),
    }), { params: Promise.resolve({ key }) });

    expect(accepted.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(key, JSON.stringify({
      nameTemplate: "Agent ({agent})",
      emailTemplate: "{agent}@leafcodepi.{machine}",
    }));
    expect(rejected.status).toBe(400);
  });

  it("rejects malformed generation model keys", async () => {
    const response = await PUT(
      request("generation-model", { value: "not-a-model" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("accepts an API or subscription provider model", async () => {
    const response = await PUT(
      request("generation-model", { value: "anthropic::claude-sonnet" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "generation-model",
      "anthropic::claude-sonnet",
    );
  });

  it("preserves a known account prefix when persisting a generation model", async () => {
    accounts.listAccounts.mockReturnValue([{ id: "acc-1" }]);
    const response = await PUT(
      request("generation-model", { value: "acc-1::anthropic::claude-sonnet" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "generation-model",
      "acc-1::anthropic::claude-sonnet",
    );
  });

  it("accepts and persists a generation-model effort", async () => {
    const response = await PUT(
      request("generation-model-effort", { value: "high" }),
      { params: Promise.resolve({ key: "generation-model-effort" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("generation-model-effort", "high");
  });

  it("rejects an invalid generation-model effort", async () => {
    const response = await PUT(
      request("generation-model-effort", { value: "turbo" }),
      { params: Promise.resolve({ key: "generation-model-effort" }) },
    );
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("accepts and persists the fallback model and effort", async () => {
    const modelResponse = await PUT(
      request("generation-fallback-model", { value: "ollama-cloud::qwen3" }),
      { params: Promise.resolve({ key: "generation-fallback-model" }) },
    );
    const effortResponse = await PUT(
      request("generation-fallback-model-effort", { value: "low" }),
      { params: Promise.resolve({ key: "generation-fallback-model-effort" }) },
    );

    expect(modelResponse.status).toBe(200);
    expect(effortResponse.status).toBe(200);
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      1,
      "generation-fallback-model",
      "ollama-cloud::qwen3",
    );
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      2,
      "generation-fallback-model-effort",
      "low",
    );
  });

  it("rejects an invalid fallback effort", async () => {
    const response = await PUT(
      request("generation-fallback-model-effort", { value: "turbo" }),
      { params: Promise.resolve({ key: "generation-fallback-model-effort" }) },
    );

    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("accepts valid Auto settings and normalizes route overrides", async () => {
    const modeResponse = await PUT(
      request("auto-optimize", { value: "intelligence" }),
      { params: Promise.resolve({ key: "auto-optimize" }) },
    );
    const routeResponse = await PUT(
      request("auto-route-overrides", {
        value: JSON.stringify({
          light: { costOrder: ["cheap", "mid"] },
        }),
      }),
      { params: Promise.resolve({ key: "auto-route-overrides" }) },
    );

    expect(modeResponse.status).toBe(200);
    expect(routeResponse.status).toBe(200);
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      1,
      "auto-optimize",
      "intelligence",
    );
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      2,
      "auto-route-overrides",
      JSON.stringify({
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [
                { kind: "cost", cost: "cheap" },
                { kind: "cost", cost: "mid" },
              ],
            },
          },
          balanced: {
            light: {
              candidates: [
                { kind: "cost", cost: "cheap" },
                { kind: "cost", cost: "mid" },
              ],
            },
          },
          intelligence: {
            light: {
              candidates: [
                { kind: "cost", cost: "cheap" },
                { kind: "cost", cost: "mid" },
              ],
            },
          },
        },
      }),
    );
  });

  it("exposes the default Auto agent selector prompt", async () => {
    const response = await GET(
      new NextRequest("http://127.0.0.1:3010/api/settings/auto-agent-prompt"),
      { params: Promise.resolve({ key: "auto-agent-prompt" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      value: "llama-server::local-model",
      defaultPrompt: expect.stringContaining(
        "コーディング作業に適したエージェントを1つ選ぶルーター",
      ),
    });
  });

  it("accepts and persists the Auto agent enabled setting", async () => {
    const enabled = await PUT(
      request("auto-agent-enabled", { value: "1" }),
      { params: Promise.resolve({ key: "auto-agent-enabled" }) },
    );
    const disabled = await PUT(
      request("auto-agent-enabled", { value: "0" }),
      { params: Promise.resolve({ key: "auto-agent-enabled" }) },
    );
    const invalid = await PUT(
      request("auto-agent-enabled", { value: "yes" }),
      { params: Promise.resolve({ key: "auto-agent-enabled" }) },
    );

    expect(enabled.status).toBe(200);
    expect(disabled.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(settings.setSetting).toHaveBeenNthCalledWith(1, "auto-agent-enabled", "1");
    expect(settings.setSetting).toHaveBeenNthCalledWith(2, "auto-agent-enabled", "0");
  });

  it("accepts and persists the Auto model enabled setting", async () => {
    const enabled = await PUT(
      request("auto-model-enabled", { value: "1" }),
      { params: Promise.resolve({ key: "auto-model-enabled" }) },
    );
    const disabled = await PUT(
      request("auto-model-enabled", { value: "0" }),
      { params: Promise.resolve({ key: "auto-model-enabled" }) },
    );
    const invalid = await PUT(
      request("auto-model-enabled", { value: "yes" }),
      { params: Promise.resolve({ key: "auto-model-enabled" }) },
    );

    expect(enabled.status).toBe(200);
    expect(disabled.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(settings.setSetting).toHaveBeenNthCalledWith(1, "auto-model-enabled", "1");
    expect(settings.setSetting).toHaveBeenNthCalledWith(2, "auto-model-enabled", "0");
  });

  it("accepts and persists the Auto agent selector prompt", async () => {
    const response = await PUT(
      request("auto-agent-prompt", { value: "レビューは reviewer を優先" }),
      { params: Promise.resolve({ key: "auto-agent-prompt" }) },
    );

    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "auto-agent-prompt",
      "レビューは reviewer を優先",
    );
  });

  it("accepts and canonicalizes body-only prompt presets", async () => {
    const response = await PUT(
      request("composer-prompt-presets", {
        value: JSON.stringify(["  変更を確認してください  "]),
      }),
      { params: Promise.resolve({ key: "composer-prompt-presets" }) },
    );

    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "composer-prompt-presets",
      JSON.stringify(["変更を確認してください"]),
    );
  });

  it("migrates legacy named prompt presets to bodies", async () => {
    const response = await PUT(
      request("composer-prompt-presets", {
        value: JSON.stringify([{ name: "レビュー", prompt: "本文" }]),
      }),
      { params: Promise.resolve({ key: "composer-prompt-presets" }) },
    );

    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "composer-prompt-presets",
      JSON.stringify(["本文"]),
    );
  });

  it("rejects invalid prompt preset bodies", async () => {
    const response = await PUT(
      request("composer-prompt-presets", {
        value: JSON.stringify([""]),
      }),
      { params: Promise.resolve({ key: "composer-prompt-presets" }) },
    );

    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("rejects invalid Auto settings and clears the show-model setting", async () => {
    const invalidMode = await PUT(
      request("auto-optimize", { value: "turbo" }),
      { params: Promise.resolve({ key: "auto-optimize" }) },
    );
    const invalidShowModel = await PUT(
      request("auto-show-model", { value: "true" }),
      { params: Promise.resolve({ key: "auto-show-model" }) },
    );
    const clearShowModel = await PUT(
      request("auto-show-model", { value: "" }),
      { params: Promise.resolve({ key: "auto-show-model" }) },
    );

    expect(invalidMode.status).toBe(400);
    expect(await invalidMode.json()).toEqual({
      error: "auto-optimize must be cost, balanced or intelligence",
    });
    expect(invalidShowModel.status).toBe(400);
    expect(clearShowModel.status).toBe(200);
    expect(settings.setSetting).toHaveBeenLastCalledWith("auto-show-model", null);
  });

  it("accepts and validates the title auto-update frequency", async () => {
    const response = await PUT(
      request("title-auto-update-frequency", { value: "10" }),
      { params: Promise.resolve({ key: "title-auto-update-frequency" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("title-auto-update-frequency", "10");

    const invalid = await PUT(
      request("title-auto-update-frequency", { value: "0" }),
      { params: Promise.resolve({ key: "title-auto-update-frequency" }) },
    );
    expect(invalid.status).toBe(400);
  });

  it("accepts and validates the title auto-update enabled default", async () => {
    const response = await PUT(
      request("title-auto-update-enabled", { value: "1" }),
      { params: Promise.resolve({ key: "title-auto-update-enabled" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("title-auto-update-enabled", "1");

    const off = await PUT(
      request("title-auto-update-enabled", { value: "0" }),
      { params: Promise.resolve({ key: "title-auto-update-enabled" }) },
    );
    expect(off.status).toBe(200);

    const invalid = await PUT(
      request("title-auto-update-enabled", { value: "yes" }),
      { params: Promise.resolve({ key: "title-auto-update-enabled" }) },
    );
    expect(invalid.status).toBe(400);
  });

  it.each(["off", "7", "14", "30", "90", "180", "365"])("accepts auto-archive option %s", async (value) => {
    const response = await PUT(request("auto-archive-days", { value }), {
      params: Promise.resolve({ key: "auto-archive-days" }),
    });
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("auto-archive-days", value);
  });

  it.each(["0", "1", "15", "366", "always", "NaN"])("rejects auto-archive option %s", async (value) => {
    const response = await PUT(request("auto-archive-days", { value }), {
      params: Promise.resolve({ key: "auto-archive-days" }),
    });
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("normalizes and persists the sidebar project order", async () => {
    const response = await PUT(
      request("sidebar-project-order", { value: JSON.stringify(["p-2", "p-1", "p-2"]) }),
      { params: Promise.resolve({ key: "sidebar-project-order" }) },
    );

    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("sidebar-project-order", JSON.stringify(["p-2", "p-1"]));
  });

  it.each([JSON.stringify({ p: 1 }), JSON.stringify(["p-1", 2]), JSON.stringify([""]), "not-json"])(
    "rejects an invalid sidebar project order: %s",
    async (value) => {
      const response = await PUT(
        request("sidebar-project-order", { value }),
        { params: Promise.resolve({ key: "sidebar-project-order" }) },
      );

      expect(response.status).toBe(400);
      expect(settings.setSetting).not.toHaveBeenCalled();
    },
  );

  it("normalizes and persists pinned task ids", async () => {
    const response = await PUT(
      request("sidebar-pinned-tasks", { value: JSON.stringify(["task-2", "task-1", "task-2"]) }),
      { params: Promise.resolve({ key: "sidebar-pinned-tasks" }) },
    );

    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "sidebar-pinned-tasks",
      JSON.stringify(["task-2", "task-1"]),
    );
  });

  it.each([
    JSON.stringify({ task: "task-1" }),
    JSON.stringify(["task-1", 2]),
    "not-json",
  ])("rejects an invalid pinned task list: %s", async (value) => {
    const response = await PUT(
      request("sidebar-pinned-tasks", { value }),
      { params: Promise.resolve({ key: "sidebar-pinned-tasks" }) },
    );

    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it.each([
    ["composer-defaults", JSON.stringify({ model: " p::m ", autoOptimize: "cost", agent: "a", thinkingLevel: "high" }), JSON.stringify({ model: "p::m", autoOptimize: "cost", agent: "a", thinkingLevel: "high" })],
    ["scroll-button-opacity", "5", "1"],
    ["task-pane-prefer-new", "1", "1"],
    ["reasoning-translation-mode", "bilingual", "bilingual"],
    ["tts-playback-rate", "0.1", "0.5"],
    ["tts-playback-volume", "150", "100"],
  ])("normalizes server-owned UI setting %s", async (key, value, stored) => {
    const response = await PUT(request(key, { value }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(key, stored);
  });

  it.each([
    ["composer-defaults", "{"],
    ["composer-defaults", "[]"],
    ["scroll-button-opacity", "abc"],
    ["task-pane-prefer-new", "yes"],
    ["reasoning-translation-mode", "other"],
    ["tts-playback-rate", ""],
  ])("rejects invalid server-owned UI setting %s=%s", async (key, value) => {
    const response = await PUT(request(key, { value }), { params: Promise.resolve({ key }) });
    if (value === "") {
      expect(settings.setSetting).toHaveBeenCalledWith(key, null);
      return;
    }
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });});
