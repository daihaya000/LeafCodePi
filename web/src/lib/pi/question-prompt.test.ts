import { describe, expect, it, vi } from "vitest";
import { createQuestionPromptService } from "./question-prompt";

const QUESTIONS = [
  {
    question: "どちらで進めますか？",
    options: [
      { label: "A案" },
      { label: "B案", description: "安全寄り" },
    ],
  },
];

function createService(emit = vi.fn()) {
  const service = createQuestionPromptService({
    resolveTaskId: (sessionId) => (sessionId === "sess-1" ? "task-a" : null),
    emit,
    snapshotExtras: () => ({}),
  });
  return { service, emit };
}

describe("createQuestionPromptService", () => {
  it("emits a question request and resolves with the user's answer", async () => {
    const { service, emit } = createService();

    const pending = service.handleRequest({
      id: "q-1",
      sessionId: "sess-1",
      questions: QUESTIONS,
    });

    expect(service.pendingForTask("task-a")?.id).toBe("q-1");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].eventType).toBe("question_request");

    expect(service.respond("task-a", "q-1", { answers: [["B案"]] })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: [["B案"]] });
    expect(service.pendingForTask("task-a")).toBeNull();
    // 解決済みスナップショットも配信される
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1].eventType).toBe("question_resolved");
  });

  it("resolves null on reject and rejects unknown request ids", async () => {
    const { service } = createService();

    const pending = service.handleRequest({
      id: "q-2",
      sessionId: "sess-1",
      questions: QUESTIONS,
    });

    expect(service.respond("task-a", "missing", null)).toBe(false);
    expect(service.respond("task-a", "q-2", null)).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it("drops requests whose session cannot be mapped to a task", async () => {
    const { service } = createService();
    await expect(
      service.handleRequest({ id: "q-3", sessionId: "unknown", questions: QUESTIONS }),
    ).resolves.toBeNull();
    expect(service.pendingForTask("task-a")).toBeNull();
  });

  it("queues concurrent questions per task and answers them in order", async () => {
    const { service } = createService();
    const first = service.handleRequest({
      id: "q-4",
      sessionId: "sess-1",
      questions: QUESTIONS,
    });
    const second = service.handleRequest({
      id: "q-5",
      sessionId: "sess-1",
      questions: QUESTIONS,
    });

    // 先頭は q-4。応答すると q-5 が繰り上がる。
    expect(service.respond("task-a", "q-5", { answers: [["x"]] })).toBe(false);
    expect(service.respond("task-a", "q-4", { answers: [["a"]] })).toBe(true);
    expect(service.pendingForTask("task-a")?.id).toBe("q-5");
    expect(service.respond("task-a", "q-5", { answers: [["b"]] })).toBe(true);

    await expect(first).resolves.toEqual({ answers: [["a"]] });
    await expect(second).resolves.toEqual({ answers: [["b"]] });
  });

  it("clears queued questions on abort so a later prompt is not blocked", async () => {
    const { service, emit } = createService();
    const first = service.handleRequest({
      id: "q-6",
      sessionId: "sess-1",
      questions: QUESTIONS,
    });
    const second = service.handleRequest({
      id: "q-7",
      sessionId: "sess-1",
      questions: QUESTIONS,
    });

    expect(service.clearPendingForTask("task-a")).toBe(true);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(service.pendingForTask("task-a")).toBeNull();
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({
      eventType: "question_resolved",
      questionRequest: null,
    });
  });
});
