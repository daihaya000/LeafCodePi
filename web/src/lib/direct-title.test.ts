import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  generateDirectTextWithFallbackResult: vi.fn(),
  getSetting: vi.fn((_key: string) => ""),
  readSessionConversation: vi.fn(() => [{ role: "user", text: "hello" }]),
}));

vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));

vi.mock("@/lib/direct-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/direct-generation")>();
  return {
    ...actual,
    generateDirectTextWithFallbackResult: state.generateDirectTextWithFallbackResult,
  };
});

vi.mock("@/lib/pi/web-settings", () => ({
  getSetting: state.getSetting,
}));

vi.mock("@/lib/direct-session", () => ({
  readSessionConversation: state.readSessionConversation,
}));

import { insertTask } from "./store";
import { refreshTaskTitleDirect } from "./direct-title";
import {
  GENERATION_MODEL_SETTING_KEY,
} from "./generation-model-key";

describe("refreshTaskTitleDirect account pin", () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), "direct-title-"));
    state.generateDirectTextWithFallbackResult.mockReset();
    state.getSetting.mockReset().mockImplementation((key: string) =>
      key === GENERATION_MODEL_SETTING_KEY ? "anthropic::claude-sonnet" : "",
    );
    state.readSessionConversation.mockReset().mockReturnValue([{ role: "user", text: "hello" }]);
    state.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: "短いタイトル",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    });
  });

  afterEach(() => {
    rmSync(state.root, { recursive: true, force: true });
  });

  it("forwards task accountIdExplicit so paused accounts do not silently switch", async () => {
    const task = insertTask({
      project: null,
      title: "t",
      providerID: "anthropic",
      modelID: "claude-sonnet",
      accountId: "acc-pinned",
      accountIdExplicit: true,
    });

    await refreshTaskTitleDirect(task.id);

    expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-pinned",
        accountIdExplicit: true,
      }),
    );
  });

  it("omits accountIdExplicit when the task did not pin an account", async () => {
    const task = insertTask({
      project: null,
      title: "t",
      providerID: "anthropic",
      modelID: "claude-sonnet",
      accountId: "acc-soft",
    });

    await refreshTaskTitleDirect(task.id);

    const call = state.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(call).toMatchObject({ accountId: "acc-soft" });
    expect(call).not.toHaveProperty("accountIdExplicit");
  });
});
