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

import { getTask, insertTask, patchTask } from "./store";
import {
  backfillMissingTaskLabels,
  ensureTaskLabelDirect,
  refineInitialTaskLabel,
  refreshTaskLabelDirect,
  refreshTaskTitleDirect,
} from "./direct-title";
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

  it("waits for a cold Jev catalog instead of skipping Jev for labels", async () => {
    state.getSetting.mockImplementation((key: string) => (key === "auto-jev-enabled" ? "1" : ""));
    state.hasUsableJevModelConfigured.mockClear();
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    await refreshTaskLabelDirect(task.id);

    expect(state.hasUsableJevModelConfigured).toHaveBeenCalledWith({ waitMs: 15_000 });
  });

  it("asks the title model for a label when Jev and the keyword rule both miss", async () => {
    state.emitTaskChanged.mockClear();
    state.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: "ラベル: 「調査」",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    });
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    await expect(ensureTaskLabelDirect(task.id)).resolves.toBe("research");

    expect(getTask(task.id)?.label).toBe("research");
    expect(state.emitTaskChanged).toHaveBeenCalledWith(task.id, "label_changed");
    const call = state.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(call.system).toContain("- デバッグ: 不具合");
    expect(call.prompt).toContain("<transcript>");
    expect(call.prompt).toContain("User: hello");
  });

  it("keeps the keyword label without a model call and leaves labelled tasks alone", async () => {
    state.readSessionConversation.mockReturnValue([{ role: "user", text: "不具合を修正" }]);
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const labelled = insertTask({ project: null, title: "t", label: "ops", providerID: "anthropic", modelID: "claude-sonnet" });

    await expect(ensureTaskLabelDirect(task.id)).resolves.toBe("debug");
    await expect(ensureTaskLabelDirect(labelled.id)).resolves.toBe("ops");

    expect(getTask(labelled.id)?.label).toBe("ops");
    expect(state.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("relabels a task whose label definition was deleted", async () => {
    state.readSessionConversation.mockReturnValue([{ role: "user", text: "不具合を修正" }]);
    const orphaned = insertTask({ project: null, title: "t", label: "deleted-label", providerID: "anthropic", modelID: "claude-sonnet" });
    patchTask(orphaned.id, { sessionFile: join(state.root, "orphaned.jsonl") });

    await expect(backfillMissingTaskLabels()).resolves.toBe(1);

    expect(getTask(orphaned.id)?.label).toBe("debug");
  });

  it("lets Jev refine the creation label and falls back to the title model only without one", async () => {
    const ruled = insertTask({ project: null, title: "t", label: "debug", providerID: "anthropic", modelID: "claude-sonnet" });
    await expect(refineInitialTaskLabel(ruled.id, "不具合を修正")).resolves.toBe("debug");
    expect(state.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();

    state.getSetting.mockImplementation((key: string) =>
      key === GENERATION_MODEL_SETTING_KEY ? "anthropic::claude-sonnet" : key === "auto-jev-enabled" ? "1" : "",
    );
    state.hasUsableJevModelConfigured.mockResolvedValueOnce(true);
    state.classifySessionLabelWithJev.mockResolvedValueOnce("research");
    await expect(refineInitialTaskLabel(ruled.id, "不具合を修正")).resolves.toBe("research");
    expect(getTask(ruled.id)?.label).toBe("research");

    state.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: "チャット",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    });
    const unlabelled = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    await expect(refineInitialTaskLabel(unlabelled.id, "hello")).resolves.toBe("chat");
    expect(getTask(unlabelled.id)?.label).toBe("chat");
  });

  it("shares one classification between the turn-end job and the pane request", async () => {
    let reply!: (value: { text: string; model: { providerID: string; modelID: string } }) => void;
    state.generateDirectTextWithFallbackResult.mockReturnValue(new Promise((resolve) => { reply = resolve; }));
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    const background = ensureTaskLabelDirect(task.id);
    const pane = refreshTaskLabelDirect(task.id);
    await vi.waitFor(() => expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalled());
    reply({ text: "運用", model: { providerID: "anthropic", modelID: "claude-sonnet" } });

    await expect(background).resolves.toBe("ops");
    await expect(pane).resolves.toMatchObject({ label: "ops", task: { label: "ops" } });
    expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledOnce();
  });

  it("backfills the newest unlabelled sessions up to the limit", async () => {
    state.readSessionConversation.mockReturnValue([{ role: "user", text: "不具合を修正" }]);
    const noSession = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const older = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const newer = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    patchTask(older.id, { sessionFile: join(state.root, "older.jsonl") });
    patchTask(newer.id, { sessionFile: join(state.root, "newer.jsonl") });

    await expect(backfillMissingTaskLabels(1)).resolves.toBe(1);
    expect(getTask(newer.id)?.label).toBe("debug");
    expect(getTask(older.id)?.label).toBeUndefined();

    await expect(backfillMissingTaskLabels()).resolves.toBe(1);
    expect(getTask(older.id)?.label).toBe("debug");
    expect(getTask(noSession.id)?.label).toBeUndefined();
  });

  it("notifies open panes when the Jev label settles", async () => {
    state.getSetting.mockImplementation((key: string) =>
      key === GENERATION_MODEL_SETTING_KEY ? "anthropic::claude-sonnet" : key === "auto-jev-enabled" ? "1" : "",
    );
    state.emitTaskChanged.mockClear();
    state.hasUsableJevModelConfigured.mockResolvedValueOnce(true);
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    await refreshTaskTitleDirect(task.id);

    await vi.waitFor(() => expect(state.emitTaskChanged).toHaveBeenCalledWith(task.id, "label_changed"));
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
