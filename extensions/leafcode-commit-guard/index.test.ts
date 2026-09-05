import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerCommitGuard, {
  classifyRepoMutation,
  hasPotentialRepoMutation,
  shouldRequestCommitGate,
} from "./index.ts";

type Handler = (...args: unknown[]) => unknown;

function mutationMessages(toolName: string, argumentsValue: Record<string, unknown> = {}): AgentEndEvent["messages"] {
  return [{
    role: "assistant",
    content: [{ type: "toolCall", name: toolName, arguments: argumentsValue }],
  }] as unknown as AgentEndEvent["messages"];
}

function createPi(exec: ReturnType<typeof vi.fn>) {
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    exec,
    sendMessage,
  } as unknown as ExtensionAPI;
  return { handlers, sendMessage, pi };
}

const ctx = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;

describe("leafcode-commit-guard", () => {
  it("recognizes file edits and mutating shell commands but not read-only git commands", () => {
    expect(hasPotentialRepoMutation(mutationMessages("edit"))).toBe(true);
    expect(classifyRepoMutation(mutationMessages("edit"))).toBe("hard");
    expect(classifyRepoMutation(mutationMessages("powershell", { command: "Set-Content -Path file.txt -Value x" }))).toBe("soft");
    expect(classifyRepoMutation(mutationMessages("bash", { command: "npm install lodash" }))).toBe("soft");
    expect(hasPotentialRepoMutation(mutationMessages("bash", { command: "git status --short && git diff" }))).toBe(false);
    expect(hasPotentialRepoMutation(mutationMessages("bash", { command: "git status --short 2>&1" }))).toBe(false);
  });

  it("requires fingerprint or hard mutation when the session started dirty", () => {
    expect(shouldRequestCommitGate({
      initiallyDirty: false,
      dirty: true,
      statusChanged: false,
      hardMutation: false,
      reminderSent: false,
    })).toBe(true);
    expect(shouldRequestCommitGate({
      initiallyDirty: true,
      dirty: true,
      statusChanged: false,
      hardMutation: false,
      reminderSent: false,
    })).toBe(false);
    expect(shouldRequestCommitGate({
      initiallyDirty: true,
      dirty: true,
      statusChanged: true,
      hardMutation: false,
      reminderSent: false,
    })).toBe(true);
    expect(shouldRequestCommitGate({
      initiallyDirty: true,
      dirty: true,
      statusChanged: false,
      hardMutation: true,
      reminderSent: false,
    })).toBe(true);
    expect(shouldRequestCommitGate({
      initiallyDirty: false,
      dirty: true,
      statusChanged: false,
      hardMutation: true,
      reminderSent: true,
    })).toBe(false);
  });

  it("enqueues a follow-up after a clean session becomes dirty", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({ stdout: " M src/example.ts\n", stderr: "", code: 0, killed: false });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("edit") });
    await handlers.get("agent_settled")?.({}, ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "leafcode-commit-gate", display: false }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("treats a dirty fingerprint change as mutation even without shell heuristics", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: " M preexisting.ts\n", stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({
        stdout: " M preexisting.ts\n?? node_modules/.package-lock.json\n",
        stderr: "",
        code: 0,
        killed: false,
      });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("bash", { command: "git status --short 2>&1" }) });
    await handlers.get("agent_settled")?.({}, ctx);

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not fire on soft shell heuristics alone when the tree was already dirty", async () => {
    const dirty = " M preexisting.ts\n";
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: dirty, stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({ stdout: dirty, stderr: "", code: 0, killed: false });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("bash", { command: "npm install lodash" }) });
    await handlers.get("agent_settled")?.({}, ctx);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fires on hard edits even when porcelain stays unchanged on a pre-dirty tree", async () => {
    const dirty = " M preexisting.ts\n";
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: dirty, stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({ stdout: dirty, stderr: "", code: 0, killed: false });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("edit") });
    await handlers.get("agent_settled")?.({}, ctx);

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not drop a gate that settles before a slow session_start finishes", async () => {
    let resolveStart: ((value: { stdout: string; stderr: string; code: number; killed: boolean }) => void) | undefined;
    const startStatus = new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve) => {
      resolveStart = resolve;
    });
    const exec = vi
      .fn()
      .mockImplementationOnce(() => startStatus)
      .mockResolvedValueOnce({ stdout: " M src/example.ts\n", stderr: "", code: 0, killed: false });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    const started = handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("edit") });
    await handlers.get("agent_settled")?.({}, ctx);
    expect(sendMessage).not.toHaveBeenCalled();
    resolveStart?.({ stdout: "", stderr: "", code: 0, killed: false });
    await started;
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not treat a failed git status as clean or clear in-flight mutation state", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, killed: false })
      // First settle: git fails (timeout/kill) — must not wipe hardMutationObserved.
      .mockResolvedValueOnce({ stdout: "", stderr: "timeout", code: null, killed: true })
      // Second settle: dirty tree observed successfully.
      .mockResolvedValueOnce({ stdout: " M src/example.ts\n", stderr: "", code: 0, killed: false });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("edit") });
    await handlers.get("agent_settled")?.({}, ctx);
    expect(sendMessage).not.toHaveBeenCalled();

    await handlers.get("agent_settled")?.({}, ctx);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not force initiallyDirty=false on a late session_start after soft mutation", async () => {
    const dirty = " M preexisting.ts\n";
    let resolveStart: ((value: { stdout: string; stderr: string; code: number; killed: boolean }) => void) | undefined;
    const startStatus = new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve) => {
      resolveStart = resolve;
    });
    const exec = vi
      .fn()
      .mockImplementationOnce(() => startStatus)
      .mockResolvedValueOnce({ stdout: dirty, stderr: "", code: 0, killed: false });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    const started = handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("bash", { command: "npm ci" }) });
    await handlers.get("agent_settled")?.({}, ctx);
    resolveStart?.({ stdout: dirty, stderr: "", code: 0, killed: false });
    await started;

    // Pre-existing dirt + soft shell only must not become a false-positive gate
    // just because session_start finished late.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("re-arms the reminder when the dirty fingerprint changes after a prior gate", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({ stdout: " M a.ts\n", stderr: "", code: 0, killed: false })
      .mockResolvedValueOnce({ stdout: " M a.ts\n M b.ts\n", stderr: "", code: 0, killed: false });
    const { handlers, sendMessage, pi } = createPi(exec);

    registerCommitGuard(pi);
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_end")?.({ messages: mutationMessages("edit") });
    await handlers.get("agent_settled")?.({}, ctx);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    handlers.get("agent_end")?.({ messages: mutationMessages("edit") });
    await handlers.get("agent_settled")?.({}, ctx);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
