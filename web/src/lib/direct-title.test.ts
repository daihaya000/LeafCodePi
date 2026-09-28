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
  listActiveLlamaAgentModels: () => [],
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
import { BOT_PROMPT_PREFIX } from "./pi/messages";
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
import { LocalAgentBusyError } from "./direct-generation";

describe("refreshTaskTitleDirect account pin", () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), "direct-title-"));
    state.generateDirectTextWithFallbackResult.mockReset();
    state.hasUsableJevModelConfigured.mockReset().mockResolvedValue(false);
    state.classifySessionLabelWithJev.mockReset().mockResolvedValue("code");
    state.emitTaskChanged.mockReset();
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

  /** Jev labelling on with a usable model; Jev itself misses unless a test says otherwise. */
  function useJevThatMisses(): void {
    state.getSetting.mockImplementation((key: string) =>
      key === GENERATION_MODEL_SETTING_KEY ? "anthropic::claude-sonnet" : key === "auto-jev-enabled" ? "1" : "",
    );
    state.hasUsableJevModelConfigured.mockResolvedValue(true);
    state.classifySessionLabelWithJev.mockResolvedValue(undefined);
  }

  const model = { providerID: "anthropic", modelID: "claude-sonnet" };

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
    const withoutJev = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const withJev = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    state.readSessionConversation.mockReturnValue([{ role: "user", text: "不具合とエラー" }]);

    state.hasUsableJevModelConfigured.mockResolvedValueOnce(false);
    expect((await refreshTaskLabelDirect(withoutJev.id)).label).toBe("debug");
    expect(state.classifySessionLabelWithJev).not.toHaveBeenCalled();

    state.hasUsableJevModelConfigured.mockResolvedValueOnce(true);
    expect((await refreshTaskLabelDirect(withJev.id)).label).toBe("code");
    expect(state.classifySessionLabelWithJev).toHaveBeenCalledOnce();
  });

  it("returns an already known label to the pane without classifying again", async () => {
    state.getSetting.mockImplementation((key: string) => (key === "auto-jev-enabled" ? "1" : ""));
    state.hasUsableJevModelConfigured.mockResolvedValue(true);
    const labelled = insertTask({ project: null, title: "t", label: "ops", providerID: "anthropic", modelID: "claude-sonnet" });

    await expect(refreshTaskLabelDirect(labelled.id)).resolves.toMatchObject({ label: "ops" });

    expect(state.classifySessionLabelWithJev).not.toHaveBeenCalled();
    expect(state.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("waits for a cold Jev catalog instead of skipping Jev for labels", async () => {
    state.getSetting.mockImplementation((key: string) => (key === "auto-jev-enabled" ? "1" : ""));
    state.hasUsableJevModelConfigured.mockClear();
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    await refreshTaskLabelDirect(task.id);

    expect(state.hasUsableJevModelConfigured).toHaveBeenCalledWith({ waitMs: 15_000 });
  });

  it("asks the title model for a label when Jev and the keyword rule both miss", async () => {
    useJevThatMisses();
    state.generateDirectTextWithFallbackResult.mockResolvedValue({ text: "ラベル: 「調査」", model });
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const updatedAt = getTask(task.id)?.updatedAt;

    await expect(ensureTaskLabelDirect(task.id)).resolves.toBe("research");

    // A background label is not activity: sidebar order, unread and auto-archive stay put.
    expect(getTask(task.id)).toMatchObject({ label: "research", updatedAt });
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

  it("makes no extra model request when Jev is off, as the settings screen promises", async () => {
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    await expect(ensureTaskLabelDirect(task.id)).resolves.toBeUndefined();
    await expect(refineInitialTaskLabel(task.id, "hello")).resolves.toBeUndefined();

    expect(state.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
    expect(state.classifySessionLabelWithJev).not.toHaveBeenCalled();
  });

  it("retries a label after local-agent contention instead of caching it as a miss", async () => {
    useJevThatMisses();
    state.getSetting.mockImplementation((key: string) =>
      key === GENERATION_MODEL_SETTING_KEY
        ? "llama-server::local-model"
        : key === "auto-jev-enabled"
          ? "1"
          : "",
    );
    state.generateDirectTextWithFallbackResult
      .mockRejectedValueOnce(new LocalAgentBusyError())
      .mockResolvedValueOnce({ text: "ラベル: 調査", model: { providerID: "llama-server", modelID: "local-model" } });
    const task = insertTask({ project: null, title: "t", providerID: "llama-server", modelID: "local-model" });

    await expect(ensureTaskLabelDirect(task.id)).resolves.toBeUndefined();
    await expect(ensureTaskLabelDirect(task.id)).resolves.toBe("research");

    expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledTimes(2);
    expect(state.classifySessionLabelWithJev).toHaveBeenCalledTimes(2);
  });

  it("does not resend a transcript on which Jev and the title model already missed", async () => {
    useJevThatMisses();
    state.generateDirectTextWithFallbackResult.mockResolvedValue({ text: "不明", model });
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    await expect(ensureTaskLabelDirect(task.id)).resolves.toBeUndefined();
    await expect(ensureTaskLabelDirect(task.id)).resolves.toBeUndefined();
    expect(state.classifySessionLabelWithJev).toHaveBeenCalledOnce();
    expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledOnce();

    // New conversation text is a new input, and the cheap rule always re-runs.
    state.readSessionConversation.mockReturnValue([
      { role: "user", text: "hello" },
      { role: "assistant", text: "How can I help?" },
    ]);
    await expect(ensureTaskLabelDirect(task.id)).resolves.toBeUndefined();
    expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledTimes(2);
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

    useJevThatMisses();
    state.classifySessionLabelWithJev.mockResolvedValueOnce("research");
    await expect(refineInitialTaskLabel(ruled.id, `${BOT_PROMPT_PREFIX}不具合を修正`)).resolves.toBe("research");
    expect(getTask(ruled.id)?.label).toBe("research");
    // Internal prompt markers are not part of what the session is about.
    expect(state.classifySessionLabelWithJev).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "User: 不具合を修正" }), expect.anything());

    state.generateDirectTextWithFallbackResult.mockResolvedValue({ text: "チャット", model });
    const unlabelled = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    await expect(refineInitialTaskLabel(unlabelled.id, "hello")).resolves.toBe("chat");
    expect(getTask(unlabelled.id)?.label).toBe("chat");
  });

  it("shares one classification between the turn-end job and the pane request", async () => {
    useJevThatMisses();
    let reply!: (value: { text: string; model: typeof model }) => void;
    state.generateDirectTextWithFallbackResult.mockReturnValue(new Promise((resolve) => { reply = resolve; }));
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    const background = ensureTaskLabelDirect(task.id);
    const pane = refreshTaskLabelDirect(task.id);
    await vi.waitFor(() => expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalled());
    reply({ text: "運用", model });

    await expect(background).resolves.toBe("ops");
    await expect(pane).resolves.toMatchObject({ label: "ops", task: { label: "ops" } });
    expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledOnce();
  });

  it("runs its own classification when the shared creation job finds nothing", async () => {
    useJevThatMisses();
    let firstReply!: (value: { text: string; model: typeof model }) => void;
    state.generateDirectTextWithFallbackResult
      .mockReturnValueOnce(new Promise((resolve) => { firstReply = resolve; }))
      .mockResolvedValueOnce({ text: "調査", model });
    state.readSessionConversation.mockReturnValue([
      { role: "user", text: "hello" },
      { role: "assistant", text: "How can I help?" },
    ]);
    const task = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });

    // The creation job only knows the prompt; the turn-end job also sees the reply.
    const creation = refineInitialTaskLabel(task.id, "hello");
    const turnEnd = ensureTaskLabelDirect(task.id);
    await vi.waitFor(() => expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledOnce());
    firstReply({ text: "不明", model });

    await expect(creation).resolves.toBeUndefined();
    await expect(turnEnd).resolves.toBe("research");
    expect(state.generateDirectTextWithFallbackResult).toHaveBeenCalledTimes(2);
  });

  it("backfills every unlabelled session, newest first", async () => {
    state.readSessionConversation.mockReturnValue([{ role: "user", text: "不具合を修正" }]);
    const oldest = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const noSession = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const older = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    const newer = insertTask({ project: null, title: "t", providerID: "anthropic", modelID: "claude-sonnet" });
    for (const task of [oldest, older, newer]) {
      patchTask(task.id, { sessionFile: join(state.root, `${task.id}.jsonl`) });
    }

    await expect(backfillMissingTaskLabels(1)).resolves.toBe(1);
    expect(getTask(newer.id)?.label).toBe("debug");
    expect(getTask(older.id)?.label).toBeUndefined();

    // No per-run cap: sessions that keep failing cannot starve older ones.
    await expect(backfillMissingTaskLabels()).resolves.toBe(2);
    expect(getTask(older.id)?.label).toBe("debug");
    expect(getTask(oldest.id)?.label).toBe("debug");
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
