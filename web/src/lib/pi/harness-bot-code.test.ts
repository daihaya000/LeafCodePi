import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/store", () => ({ getTask: () => undefined }));
import { clearPendingAttentionForTask, isOneToOneBotTask, pendingPermissionForTask, pendingQuestionForTask, respondToPermissionPrompt, respondToQuestionPrompt, subscribeTask } from "./harness";
import { requestWebUiPermission } from "./webui-permission-bridge";
import { requestWebUiQuestion } from "./webui-question-bridge";

const globals = globalThis as Record<string, unknown>;
let unsubscribe: (() => void) | undefined;
beforeEach(() => {
  globals.__leafcodePiHarness = {
    live: new Map([
      ["code", { taskId: "code", session: { sessionId: "code-session" } }],
      ["code-2", { taskId: "code-2", session: { sessionId: "code-2-session" } }],
      ["bot:one", { taskId: "bot:one", session: { sessionId: "bot-session" } }],
    ]),
    events: new EventEmitter(),
  };
  globals.__leafcodeBotCodeRelay = {
    codeTasksForOrigin: (id: string) => id === "bot:one" ? ["code", "code-2"] : [],
    codeForOrigin: (id: string) => id === "bot:one" ? "code" : null,
    originForCode: (id: string) => id === "code" || id === "code-2" ? "bot:one" : null,
  };
});
afterEach(() => {
  unsubscribe?.(); unsubscribe = undefined;
  clearPendingAttentionForTask("code"); clearPendingAttentionForTask("code-2"); clearPendingAttentionForTask("bot:one");
  delete globals.__leafcodePiHarness; delete globals.__leafcodeBotCodeRelay;
});

describe("Bot Code tool scope", () => {
  it("accepts only a persisted 1:1 Bot task, not a room task", () => {
    expect(isOneToOneBotTask({ id: "bot:one", kind: "bot", botId: "one" })).toBe(true);
    expect(isOneToOneBotTask({ id: "bot:one:room:room", kind: "bot", botId: "one" })).toBe(false);
    expect(isOneToOneBotTask({ id: "bot:one", kind: "code", botId: "one" })).toBe(false);
    expect(isOneToOneBotTask(undefined)).toBe(false);
  });
});

describe("delegated Code attention in the Bot conversation", () => {
  it("mirrors Code permission requests and lets only the originating Bot or Code answer", async () => {
    const snapshots: Record<string, unknown>[] = [];
    unsubscribe = subscribeTask("bot:one", (payload) => snapshots.push(payload));
    pendingPermissionForTask("code");
    const approval = requestWebUiPermission({ sessionId: "code-session", command: "edit", labels: [], message: "Approve Code edit" });
    const pending = pendingPermissionForTask("bot:one")!;
    expect(pending.command).toBe("edit");
    expect(snapshots.at(-1)?.permissionRequest).toEqual(pending);
    expect(respondToPermissionPrompt("bot:other", pending.id, true)).toBe(false);
    expect(respondToPermissionPrompt("bot:one", "stale", true)).toBe(false);
    expect(respondToPermissionPrompt("bot:one", pending.id, true)).toBe(true);
    expect(await approval).toBe(true);
    expect(pendingPermissionForTask("code")).toBeNull();
    expect(snapshots.at(-1)?.permissionRequest).toBeNull();
  });

  it("answers the exact waiting Code session when several run for one Bot", async () => {
    pendingPermissionForTask("code-2");
    const approval = requestWebUiPermission({ sessionId: "code-2-session", command: "edit", labels: [], message: "Approve the second Code session" });
    const pending = pendingPermissionForTask("bot:one")!;

    // The first delegated session has nothing pending; the answer must still reach the second one.
    expect(pending.message).toBe("Approve the second Code session");
    expect(respondToPermissionPrompt("bot:one", pending.id, true)).toBe(true);
    expect(await approval).toBe(true);
    expect(pendingPermissionForTask("code-2")).toBeNull();
  });

  it("returns a question answer to the exact Code request without opening Code", async () => {
    pendingQuestionForTask("code");
    const answer = requestWebUiQuestion({ sessionId: "code-session", questions: [{ question: "Which file?", header: "File", options: [{ label: "A" }] }] });
    const pending = pendingQuestionForTask("bot:one")!;
    expect(pending.questions[0].question).toBe("Which file?");
    expect(respondToQuestionPrompt("bot:other", pending.id, { answers: [["A"]] })).toBe(false);
    expect(respondToQuestionPrompt("bot:one", pending.id, { answers: [["A"]] })).toBe(true);
    expect(await answer).toEqual({ answers: [["A"]] });
    expect(pendingQuestionForTask("code")).toBeNull();
  });

  it("preserves direct Code responses and prioritizes the Bot's own approval", async () => {
    pendingPermissionForTask("bot:one");
    const botApproval = requestWebUiPermission({ sessionId: "bot-session", command: "code_session", labels: [], message: "Launch" });
    const codeApproval = requestWebUiPermission({ sessionId: "code-session", command: "edit", labels: [], message: "Edit" });
    const own = pendingPermissionForTask("bot:one")!;
    expect(own.command).toBe("code_session");
    expect(respondToPermissionPrompt("bot:one", own.id, true)).toBe(true);
    expect(await botApproval).toBe(true);
    const delegated = pendingPermissionForTask("bot:one")!;
    expect(delegated.command).toBe("edit");
    expect(respondToPermissionPrompt("code", delegated.id, false)).toBe(true);
    expect(await codeApproval).toBe(false);
    expect(pendingPermissionForTask("bot:one")).toBeNull();
  });

  it("shares pending permission state with another route module instance", async () => {
    pendingPermissionForTask("code");
    const approval = requestWebUiPermission({
      sessionId: "code-session",
      command: "edit",
      labels: [],
      message: "Approve Code edit",
    });
    const pending = pendingPermissionForTask("code")!;

    // Next can evaluate the prompt and response Route Handlers in different
    // module instances, so exercise the response from a fresh harness import.
    vi.resetModules();
    const otherHarness = await import("./harness");
    const responded = otherHarness.respondToPermissionPrompt("code", pending.id, true);
    if (!responded) clearPendingAttentionForTask("code");
    expect(responded).toBe(true);
    await expect(approval).resolves.toBe(true);
  });
});
