import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerCommitGuard, { hasPotentialRepoMutation, shouldRequestCommitGate } from "./index.ts";

type Handler = (...args: unknown[]) => unknown;

function mutationMessages(toolName: string, argumentsValue: Record<string, unknown> = {}): AgentEndEvent["messages"] {
  return [{
    role: "assistant",
    content: [{ type: "toolCall", name: toolName, arguments: argumentsValue }],
  }] as unknown as AgentEndEvent["messages"];
}

describe("leafcode-commit-guard", () => {
  it("recognizes file edits and mutating shell commands but not read-only git commands", () => {
    expect(hasPotentialRepoMutation(mutationMessages("edit"))).toBe(true);
    expect(hasPotentialRepoMutation(mutationMessages("powershell", { command: "Set-Content -Path file.txt -Value x" }))).toBe(true);
    expect(hasPotentialRepoMutation(mutationMessages("bash", { command: "git status --short && git diff" }))).toBe(false);
  });

  it("requires a new reminder only once while the worktree stays dirty", () => {
    expect(shouldRequestCommitGate({ initiallyDirty: false, dirty: true, mutationObserved: false, reminderSent: false })).toBe(true);
    expect(shouldRequestCommitGate({ initiallyDirty: true, dirty: true, mutationObserved: false, reminderSent: false })).toBe(false);
    expect(shouldRequestCommitGate({ initiallyDirty: true, dirty: true, mutationObserved: true, reminderSent: false })).toBe(true);
    expect(shouldRequestCommitGate({ initiallyDirty: false, dirty: true, mutationObserved: true, reminderSent: true })).toBe(false);
  });

  it("enqueues a follow-up after a clean session becomes dirty", async () => {
    const handlers = new Map<string, Handler>();
    const sendMessage = vi.fn();
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({ stdout: " M src/example.ts\n", stderr: "", code: 0, killed: false });
    const pi = {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      exec,
      sendMessage,
    } as unknown as ExtensionAPI;
    const ctx = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;

    registerCommitGuard(pi);
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("edit") });
    await handlers.get("agent_settled")?.({}, ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "leafcode-commit-gate", display: false }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });
});
