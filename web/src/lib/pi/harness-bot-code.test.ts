import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/store", () => ({ getTask: () => undefined }));
import { clearPendingAttentionForTask, pendingPermissionForTask, pendingQuestionForTask, respondToPermissionPrompt, respondToQuestionPrompt, subscribeTask } from "./harness";
import { requestWebUiPermission } from "./webui-permission-bridge";
import { requestWebUiQuestion } from "./webui-question-bridge";

const globals = globalThis as Record<string, unknown>;
let unsubscribe: (() => void) | undefined;
beforeEach(() => {
  globals.__leafcodePiHarness = {
    live: new Map([["code", { taskId: "code", session: { sessionId: "code-session" } }], ["bot:one", { taskId: "bot:one", session: { sessionId: "bot-session" } }]]),
    events: new EventEmitter(),
  };
  globals.__leafcodeBotCodeRelay = {
    codeForOrigin: (id: string) => id === "bot:one" ? "code" : null,
    originForCode: (id: string) => id === "code" ? "bot:one" : null,
  };
});
afterEach(() => {
  unsubscribe?.(); unsubscribe = undefined;
  clearPendingAttentionForTask("code"); clearPendingAttentionForTask("bot:one");
  delete globals.__leafcodePiHarness; delete globals.__leafcodeBotCodeRelay;
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
});
