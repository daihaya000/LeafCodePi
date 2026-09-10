// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary, UiMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn(), partView: vi.fn(), botFor: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({ PartView: mocks.partView, WorkingRow: () => null }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ useTaskPanes: () => ({ iconFor: () => null, botFor: mocks.botFor }) }));

import { TaskView } from "./TaskView";

const task: TaskSummary = {
  id: "draft-task", projectId: null, projectName: "test", title: "draft test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.partView.mockReturnValue(null);
  mocks.botFor.mockReset();
  vi.stubGlobal("EventSource", class extends EventTarget { close() {} });
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it.each([undefined, "bot-1"])("passes Bot identity only to the sending side (botId: %s)", async (botId) => {
  const bot = { id: "bot-1", name: "Code Bot" };
  mocks.botFor.mockImplementation((id) => id === bot.id ? bot : undefined);
  const messages: UiMessage[] = [
    { id: "prompt", role: "user", createdAt: 1, parts: [{ id: "prompt-text", type: "text", text: "指示" }] },
    { id: "reply", role: "assistant", createdAt: 2, parts: [{ id: "reply-text", type: "text", text: "応答" }] },
  ];
  saveTaskSessionCache({ task: { ...task, botId }, messages, isStreaming: false, isCompacting: false });
  render(<TaskView taskId={task.id} mdUp />);

  await waitFor(() => expect(mocks.partView).toHaveBeenCalled());
  const props = mocks.partView.mock.calls.map(([value]) => ({ role: value.message.role, bot: value.bot }));
  expect(props).toEqual(expect.arrayContaining([
    { role: "user", bot: botId ? bot : undefined },
    { role: "assistant", bot: undefined },
  ]));
  expect(props.filter((value) => value.role === "assistant").every((value) => value.bot === undefined)).toBe(true);
});

describe("TaskView draft submission", () => {
  it("hides the manual context compaction control from the header", () => {
    render(<TaskView taskId={task.id} mdUp />);

    expect(screen.queryByRole("button", { name: "コンテキスト圧縮" })).toBeNull();
  });

  it("keeps the full title in its edit target and separates secondary actions", () => {
    const title = "再起動オーバーレイの表示条件とヘッダーレイアウトを改善する";
    saveTaskSessionCache({ task: { ...task, title }, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp={false} />);

    const heading = screen.getByRole("heading", { name: title });
    const edit = screen.getByRole("button", { name: `タイトルを編集: ${title}` });
    expect(heading.contains(edit)).toBe(true);
    expect(edit.textContent).toBe(title);
    expect(screen.getAllByText("クリーン")).toHaveLength(1);
    const autoUpdate = screen.getByRole("switch", { name: "タイトルの自動更新" });
    expect(screen.getByRole("group", { name: "タスク操作" }).contains(autoUpdate)).toBe(false);
    expect(edit.compareDocumentPosition(autoUpdate) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(edit);
    const input = screen.getByRole("textbox", { name: "セッションタイトル" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(mocks.sendJson).not.toHaveBeenCalled();
  });

  it("edits the title and turns automatic updates off", async () => {
    const updatedTask = { ...task, title: "手動タイトル", titleAutoUpdate: false };
    mocks.sendJson.mockResolvedValue({ task: updatedTask });
    render(<TaskView taskId={task.id} mdUp />);

    fireEvent.click(screen.getByRole("button", { name: /^タイトルを編集:/ }));
    const input = screen.getByRole("textbox", { name: "セッションタイトル" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "手動タイトル" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトルを保存" }));

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/title`, { title: "手動タイトル" }, "PATCH",
    ));
    expect(await screen.findByRole("heading", { name: "手動タイトル" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "タイトルの自動更新" }).getAttribute("aria-checked")).toBe("false");
  });

  it("persists the automatic title update switch", async () => {
    const updatedTask = { ...task, titleAutoUpdate: true };
    mocks.sendJson.mockResolvedValue({ task: updatedTask });
    render(<TaskView taskId={task.id} mdUp />);

    const toggle = screen.getByRole("switch", { name: "タイトルの自動更新" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/title`, { titleAutoUpdate: true }, "PATCH",
    ));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("follows the settings default when the task has no override", async () => {
    localStorage.setItem("webui:title-auto-update-enabled", "1");
    render(<TaskView taskId={task.id} mdUp />);
    expect(screen.getByRole("switch", { name: "タイトルの自動更新" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does not regenerate a title when automatic updates are disabled", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      constructor() {
        super();
        TestEventSource.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const disabledTask = { ...task, titleAutoUpdate: false, sessionId: "session-1" };
    saveTaskSessionCache({ task: disabledTask, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const sendSnapshot = async (status: "working" | "idle") => {
      await act(async () => {
        source.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({
            eventType: "ready",
            task: { ...disabledTask, status, isStreaming: status === "working" },
            messages: [],
          }),
        }));
      });
    };
    await sendSnapshot("working");
    await sendSnapshot("idle");

    expect(mocks.sendJson).not.toHaveBeenCalled();
  });

  it("regenerates a title every five completed turns by default", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;
      constructor() {
        super();
        TestEventSource.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const sessionTask = { ...task, sessionId: "session-1", titleAutoUpdate: true };
    const turnMessages = (turns: number): UiMessage[] => Array.from(
      { length: turns * 2 },
      (_, index) => {
        const turn = Math.floor(index / 2) + 1;
        const role = index % 2 === 0 ? "user" : "assistant";
        return {
          id: `${role}-${turn}`,
          role,
          createdAt: turn,
          parts: [{ id: `${role}-${turn}-text`, type: "text", text: `${role} ${turn}` }],
        } as UiMessage;
      },
    );
    saveTaskSessionCache({ task: sessionTask, messages: [], isStreaming: false, isCompacting: false });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const sendSnapshot = async (status: "working" | "idle", turns: number) => {
      await act(async () => {
        source.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({
            eventType: "ready",
            task: { ...sessionTask, status, isStreaming: status === "working" },
            messages: turnMessages(turns),
          }),
        }));
      });
    };
    for (let turns = 1; turns <= 4; turns += 1) {
      await sendSnapshot("working", turns);
      await sendSnapshot("idle", turns);
    }
    expect(mocks.sendJson).not.toHaveBeenCalled();

    mocks.sendJson.mockResolvedValue({ title: "5ターン目のタイトル", task: sessionTask });
    await sendSnapshot("working", 5);
    await sendSnapshot("idle", 5);

    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/title`, {},
    ));
  });

  it.each(["success", "failure"])("sends queued content without replacing the next draft (%s)", async (outcome) => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource;
      constructor() { super(); TestEventSource.latest = this; }
      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    if (outcome === "failure") mocks.sendJson.mockRejectedValue(new Error("queue failed"));
    else mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    const snapshot = async (working: boolean) => {
      await act(async () => {
        TestEventSource.latest.dispatchEvent(new MessageEvent("snapshot", {
          data: JSON.stringify({ eventType: "ready", task: { ...task, status: working ? "working" : "idle", isStreaming: working }, messages: [] }),
        }));
      });
    };
    await snapshot(true);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "queued prompt" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(mocks.sendJson).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "unfinished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "割り込み" }));
    expect(screen.getByRole("button", { name: "割り込みを送信" })).toBeTruthy();
    await snapshot(false);
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "queued prompt" }),
    ));
    expect(input.value).toBe("unfinished draft");
    expect(mocks.sendJson).toHaveBeenCalledTimes(1);
    expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBeUndefined();
    if (outcome === "failure") {
      expect(await screen.findByText("queue failed")).toBeTruthy();
      expect(screen.getByText("queued prompt")).toBeTruthy();
    }
  });
  it.each([false, true])("uses steer only while working (working: %s)", async (working) => {
    saveTaskSessionCache({ task: { ...task, status: working ? "working" : "idle" }, messages: [], isStreaming: working, isCompacting: false });
    mocks.sendJson.mockResolvedValue({ task });
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "送信方式" }));
    fireEvent.click(screen.getByRole("option", { name: "割り込み" }));
    fireEvent.change(screen.getByRole("textbox", { name: "フォローアップ" }), { target: { value: "instruction" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledTimes(1));
    expect(mocks.sendJson.mock.calls[0][1].streamingBehavior).toBe(working ? "steer" : undefined);
  });

  it("refreshes worktree status when a task mutation is reported", async () => {
    const worktreeTask = { ...task, directory: "C:\\repo" };
    let changed = 1;
    saveTaskSessionCache({ task: worktreeTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockImplementation((path: string) =>
      path === "/api/diff/files"
        ? Promise.resolve({ git: true, count: changed, files: [] })
        : Promise.resolve({ models: [], agents: [], skills: [], accounts: [] }),
    );
    render(<TaskView taskId={task.id} mdUp />);
    expect((await screen.findAllByText("変更あり")).length).toBe(1);

    changed = 0;
    await act(async () => {
      window.dispatchEvent(new Event("webui:tasks-changed"));
      await Promise.resolve();
    });
    expect((await screen.findAllByText("クリーン")).length).toBe(1);
  });

  it("switches Graph and Diff instead of opening both when the timeline is narrow", () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = originalGetBoundingClientRect.call(this);
      return { ...rect, width: 800, right: rect.left + 800 } as DOMRect;
    });

    try {
      render(<TaskView taskId={task.id} mdUp />);
      const graph = screen.getByRole("button", { name: "コミットグラフ" });
      const diff = screen.getByRole("button", { name: "Diff パネル" });
      fireEvent.click(graph);
      fireEvent.click(diff);

      expect(graph.getAttribute("aria-pressed")).toBe("false");
      expect(diff.getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not show a stale model error after a newer selection succeeds", async () => {
    const modelTask = { ...task, providerID: "provider", modelID: "a", thinkingLevel: "off" as const };
    const models = ["a", "b", "c"].map((id) => ({
      value: `provider::${id}`, label: `Model ${id.toUpperCase()}`, providerID: "provider", modelID: id,
    }));
    let resolveLatest!: (result: { task: TaskSummary }) => void;
    let rejectOlder!: (reason?: unknown) => void;
    const olderResponse = new Promise<never>((_, reject) => { rejectOlder = reject; });
    const latestResponse = new Promise<{ task: TaskSummary }>((resolve) => { resolveLatest = resolve; });
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    mocks.sendJson.mockImplementation((_path: string, body: { model: string }) =>
      body.model === "provider::b" ? olderResponse : latestResponse,
    );
    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "モデル" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model B" }));
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model C" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/model`, { model: "provider::c" },
    ));
    await act(async () => {
      resolveLatest({ task: { ...modelTask, modelID: "c" } });
      await latestResponse;
    });
    await act(async () => {
      rejectOlder(new Error("stale model failure"));
      await olderResponse.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model C");
  });

  it("keeps a concrete model after leaving Auto across remount", async () => {
    const modelTask = {
      ...task,
      providerID: "provider",
      modelID: "a",
      thinkingLevel: "off" as const,
    };
    const models = ["a", "b"].map((id) => ({
      value: `provider::${id}`,
      label: `Model ${id.toUpperCase()}`,
      providerID: "provider",
      modelID: id,
    }));
    localStorage.setItem("leafcodepi.defaultModel", "auto");
    sessionStorage.setItem(
      `webui:auto-task:${task.id}`,
      JSON.stringify({
        decision: {
          providerID: "provider",
          modelID: "a",
          variant: "minimal",
          tier: "light",
          mode: "cost",
          reason: "auto",
        },
      }),
    );
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });
    mocks.sendJson.mockResolvedValue({ task: { ...modelTask, modelID: "b" } });

    const view = render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Auto");
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model B" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B"),
    );
    expect(sessionStorage.getItem(`webui:auto-task:${task.id}`)).toBeNull();
    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("provider::b");

    view.unmount();
    saveTaskSessionCache({
      task: { ...modelTask, modelID: "b" },
      messages: [],
      isStreaming: false,
      isCompacting: false,
    });
    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B"),
    );
    expect(screen.getByRole("button", { name: "モデル" }).textContent).not.toContain("Auto");
  });

  it("does not inherit Composer Auto default for a concrete-model task", async () => {
    const modelTask = {
      ...task,
      providerID: "provider",
      modelID: "a",
      thinkingLevel: "off" as const,
    };
    const models = [
      {
        value: "provider::a",
        label: "Model A",
        providerID: "provider",
        modelID: "a",
      },
    ];
    localStorage.setItem("leafcodepi.defaultModel", "auto");
    sessionStorage.clear();
    saveTaskSessionCache({ task: modelTask, messages: [], isStreaming: false, isCompacting: false });
    mocks.getJson.mockResolvedValue({ models, agents: [], skills: [], accounts: [] });

    render(<TaskView taskId={task.id} mdUp />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "モデル" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
    expect(screen.getByRole("button", { name: "モデル" }).textContent).not.toContain("Auto");
  });

  it("preserves a new draft while starting a goal loop", async () => {
    let resolve!: (value: unknown) => void;
    mocks.sendJson.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "goal" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "next draft" } });
    await act(async () => { resolve({ loop: null }); });
    expect(input.value).toBe("next draft");
  });

  it.each([false, true])("restores an untouched draft after failure (goal loop: %s)", async (goalLoop) => {
    mocks.sendJson.mockRejectedValue(new Error("request failed"));
    render(<TaskView taskId={task.id} mdUp />);
    if (goalLoop) fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "retry this" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await screen.findByText("request failed");
    expect(input.value).toBe("retry this");
  });

  it.each(["success", "failure"])("preserves text and attachments entered during a pending %s", async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    mocks.sendJson.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const { container } = render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "first prompt" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "first prompt" }),
    ));
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "next draft" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "next.png", { type: "image/png" })] },
    });
    await screen.findByRole("img", { name: "next.png" });
    await act(async () => {
      if (outcome === "success") resolve({ task });
      else reject(new Error("request failed"));
    });
    expect(input.value).toBe("next draft");
    expect(screen.getByRole("img", { name: "next.png" })).toBeTruthy();
  });

  it("keeps permission actions available when the message is long", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;

      constructor() {
        super();
        TestEventSource.latest = this;
      }

      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.sendJson.mockResolvedValue({ advice: "" });
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const message = Array.from({ length: 100 }, (_, index) => `安全ガード ${index}`).join("\n");
    await act(async () => {
      source.dispatchEvent(new MessageEvent("snapshot", {
        data: JSON.stringify({
          eventType: "ready",
          task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
          messages: [],
          permissionRequest: {
            id: "request-1",
            sessionId: "session-1",
            command: "echo test",
            labels: ["os"],
            message,
          },
          questionRequest: {
            id: "question-1",
            sessionId: "session-1",
            questions: [{ question: "続けますか？", options: [], custom: true }],
          },
        }),
      }));
    });

    const dialog = await screen.findByRole("alertdialog", { name: "危険なコマンドの確認" });
    const messageNode = dialog.querySelector("p");
    expect(messageNode?.className).toContain("max-h-32");
    expect(messageNode?.className).toContain("overflow-auto");
    expect(screen.getByRole("button", { name: "許可" })).toBeTruthy();
    expect(screen.getByText("承認待ち")).toBeTruthy();
    expect(screen.getByText("回答待ち")).toBeTruthy();
  });

  it("clears goal loop state when a snapshot explicitly sends null", async () => {
    class TestEventSource extends EventTarget {
      static latest: TestEventSource | null = null;

      constructor() {
        super();
        TestEventSource.latest = this;
      }

      close() {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    render(<TaskView taskId={task.id} mdUp />);
    const source = TestEventSource.latest;
    if (!source) throw new Error("EventSource was not created");

    const goalLoop = {
      id: "session-1",
      sessionId: "session-1",
      cwd: "",
      status: "paused",
      goal: "keep going",
      acceptance: ["done"],
      maxTurns: 3,
      cooldownSeconds: 0,
      nextTurnAt: null,
      forceFullRun: false,
      turnCount: 1,
      turnKind: "goal",
      pauseReason: "user",
      error: "",
      progress: [],
      summary: "",
      evidence: "",
      blockedReason: "",
      rejectedClaims: 0,
      unreadableStreak: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const sendSnapshot = async (payload: unknown) => {
      await act(async () => {
        source.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(payload) }));
      });
    };

    await sendSnapshot({
      eventType: "ready",
      task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
      messages: [],
      goalLoop,
    });
    expect(await screen.findByRole("region", { name: "Goal loop" })).toBeTruthy();

    await sendSnapshot({
      eventType: "restored",
      task: { ...task, sessionId: "session-1", messages: [], isStreaming: false },
      messages: [],
      goalLoop: null,
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Goal loop" })).toBeNull());
  });
});
