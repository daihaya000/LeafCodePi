import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  hasUsableJevModelConfigured: vi.fn(async () => false),
  emitTaskChanged: vi.fn(),
  classifySessionLabelWithJev: vi.fn(async (): Promise<string | undefined> => "code"),
  generateDirectTextWithFallbackResult: vi.fn(),
  getSetting: vi.fn<(key: string) => string>(() => ""),
  readSessionConversation: vi.fn(() => [{ role: "user", text: "hello" }]),
  readSessionWorkSummary: vi.fn(
    (): { todos: { content: string; status: string }[]; activity: string[] } => ({
      todos: [],
      activity: [],
    }),
  ),
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

vi.mock("@/lib/pi/harness", () => ({
  hasUsableJevModelConfigured: state.hasUsableJevModelConfigured,
  emitTaskChanged: state.emitTaskChanged,
}));

vi.mock("@/lib/auto-jev", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auto-jev")>(),
  classifySessionLabelWithJev: state.classifySessionLabelWithJev,
}));

vi.mock("@/lib/pi/web-settings", () => ({
  getSetting: state.getSetting,
}));

vi.mock("@/lib/direct-session", () => ({
  readSessionConversation: state.readSessionConversation,
  readSessionWorkSummary: state.readSessionWorkSummary,
}));

import { insertTask } from "./store";
import { refreshTaskLabelDirect, refreshTaskTitleDirect } from "./direct-title";
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
    state.readSessionWorkSummary.mockReset().mockReturnValue({ todos: [], activity: [] });
    state.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: "短いタイトル",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    });
  });

  afterEach(() => {
    rmSync(state.root, { recursive: true, force: true });
  });

  it("assigns a fallback label without generating a title", async () => {
    const task = insertTask({
      project: null,
      title: "t",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
    state.readSessionConversation.mockReturnValue([{ role: "user", text: "不具合とエラーと失敗を修正したい" }]);

    const result = await refreshTaskLabelDirect(task.id);

    expect(result.label).toBe("debug");
    expect(result.task?.label).toBe("debug");
    expect(state.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("skips Jev when no Jev model is usable and uses it once one is", async () => {
    state.getSetting.mockImplementation((key: string) => (key === "auto-jev-enabled" ? "1" : ""));
    state.classifySessionLabelWithJev.mockClear();
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    state.readSessionConversation.mockReturnValue([{ role: "user", text: "\u4e0d\u5177\u5408\u3068\u30a8\u30e9\u30fc" }]);

    state.hasUsableJevModelConfigured.mockResolvedValueOnce(false);
    expect((await refreshTaskLabelDirect(task.id)).label).toBe("debug");
    expect(state.classifySessionLabelWithJev).not.toHaveBeenCalled();

    state.hasUsableJevModelConfigured.mockResolvedValueOnce(true);
    expect((await refreshTaskLabelDirect(task.id)).label).toBe("code");
    expect(state.classifySessionLabelWithJev).toHaveBeenCalledOnce();
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

  it("falls back to the ToDo/work summary when the conversation is unavailable", async () => {
    const task = insertTask({
      project: null,
      title: "t",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
    state.readSessionConversation.mockReturnValue([]);
    state.readSessionWorkSummary.mockReturnValue({
      todos: [{ content: "履歴退避の不具合を直す", status: "in_progress" }],
      activity: ["編集: web/src/lib/direct-session.ts"],
    });

    const result = await refreshTaskTitleDirect(task.id);

    expect(result.title).toBe("短いタイトル");
    const call = state.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(call.prompt).toContain("履歴退避の不具合を直す");
    expect(call.prompt).toContain("編集: web/src/lib/direct-session.ts");
    expect(call.prompt).toContain("会話履歴は取得できませんでした");
  });

  it("prefers the conversation over the work summary when both exist", async () => {
    const task = insertTask({
      project: null,
      title: "t",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
    state.readSessionWorkSummary.mockReturnValue({
      todos: [{ content: "使われないToDo", status: "pending" }],
      activity: [],
    });

    await refreshTaskTitleDirect(task.id);

    const call = state.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(call.prompt).toContain("<transcript>");
    expect(call.prompt).not.toContain("使われないToDo");
  });

  it("rejects with 422 when neither conversation nor work summary exists", async () => {
    const task = insertTask({
      project: null,
      title: "t",
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
    state.readSessionConversation.mockReturnValue([]);

    await expect(refreshTaskTitleDirect(task.id)).rejects.toMatchObject({ status: 422 });
    expect(state.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });
});
