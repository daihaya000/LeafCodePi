import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_MODEL_VALUE } from "@/lib/auto-model";
import {
  autoTaskStorageKey,
  readAutoTaskRecord,
  resolveModelValue,
  shouldAutoRetryEscalate,
  writeAutoTaskRecord,
} from "@/lib/auto-task-record";
import type { AutoTaskRecord } from "@/lib/auto-task-record";

class MemorySessionStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

const record: AutoTaskRecord = {
  decision: {
    providerID: "anthropic",
    modelID: "claude-haiku-4-5",
    accountId: "account-1",
    variant: "minimal",
    tier: "light",
    mode: "cost",
    reason: "短い質問タスクのため低コストモデルを選択しました",
    escalation: {
      providerID: "anthropic",
      modelID: "claude-opus-5",
      accountId: "account-1",
      variant: "high",
    },
  },
  prompt: "なぜこうなるの",
  agent: "build",
  retried: true,
  dismissed: true,
};

beforeEach(() => {
  (globalThis as unknown as { sessionStorage?: MemorySessionStorage }).sessionStorage =
    new MemorySessionStorage();
});

afterEach(() => {
  delete (globalThis as unknown as { sessionStorage?: MemorySessionStorage }).sessionStorage;
});

describe("auto-task-record", () => {
  it("round-trips the decision and one-shot retry flags", () => {
    expect(writeAutoTaskRecord("task-1", record)).toBe(true);
    expect(readAutoTaskRecord("task-1")).toEqual(record);
  });

  it("ignores malformed records instead of blocking the task view", () => {
    sessionStorage.setItem(autoTaskStorageKey("task-1"), JSON.stringify({ decision: {} }));
    expect(readAutoTaskRecord("task-1")).toBeNull();

    sessionStorage.setItem(
      autoTaskStorageKey("task-1"),
      JSON.stringify({
        decision: {
          providerID: "anthropic",
          modelID: "claude-haiku-4-5",
          variant: "not-a-variant",
          tier: "light",
          mode: "cost",
          reason: "reason",
        },
      }),
    );
    expect(readAutoTaskRecord("task-1")).toBeNull();
  });

  it("keeps Auto visible when the task has a concrete resolved model", () => {
    expect(
      resolveModelValue({
        modelSelection: "",
        hasAutoRecord: true,
        accountTaskModelValue: "account-1::anthropic::claude-opus-5",
        plainTaskModelValue: "anthropic::claude-opus-5",
        firstModelValue: "openai-codex::gpt-5",
      }),
    ).toBe(AUTO_MODEL_VALUE);
  });

  it("uses the concrete model fallback order without an Auto record", () => {
    const input = {
      modelSelection: "",
      hasAutoRecord: false,
      accountTaskModelValue: "account-1::anthropic::claude-opus-5",
      plainTaskModelValue: "anthropic::claude-opus-5",
      firstModelValue: "openai-codex::gpt-5",
    };
    expect(resolveModelValue(input)).toBe(input.accountTaskModelValue);
    expect(
      resolveModelValue({ ...input, accountTaskModelValue: undefined }),
    ).toBe(input.plainTaskModelValue);
    expect(
      resolveModelValue({
        ...input,
        accountTaskModelValue: undefined,
        plainTaskModelValue: "",
      }),
    ).toBe(input.firstModelValue);
  });

  it("blocks escalation retries after a provider limit", () => {
    const eligible = {
      previousStatus: "idle" as const,
      currentStatus: "error" as const,
      limitError: false,
      hasEscalation: true,
      retried: false,
      hasPrompt: true,
      autoRetrying: false,
      userMessageCount: 1,
      hasCompletedAssistantText: false,
    };
    expect(shouldAutoRetryEscalate(eligible)).toBe(true);
    expect(
      shouldAutoRetryEscalate({ ...eligible, limitError: true }),
    ).toBe(false);
    expect(
      shouldAutoRetryEscalate({ ...eligible, userMessageCount: 2 }),
    ).toBe(false);
    expect(
      shouldAutoRetryEscalate({ ...eligible, hasCompletedAssistantText: true }),
    ).toBe(false);
  });

  it("covers every remaining escalation guard", () => {
    const eligible = {
      previousStatus: "idle" as const,
      currentStatus: "error" as const,
      limitError: false,
      hasEscalation: true,
      retried: false,
      hasPrompt: true,
      autoRetrying: false,
      userMessageCount: 1,
      hasCompletedAssistantText: false,
    };
    // A first render has no previous status, so no edge is detected.
    expect(
      shouldAutoRetryEscalate({ ...eligible, previousStatus: undefined }),
    ).toBe(false);
    // Already-errored tasks must not re-trigger on later renders.
    expect(
      shouldAutoRetryEscalate({ ...eligible, previousStatus: "error" }),
    ).toBe(false);
    // Only a transition INTO error counts.
    for (const status of ["idle", "ready", "working", "archived", "unknown"] as const) {
      expect(
        shouldAutoRetryEscalate({ ...eligible, currentStatus: status }),
      ).toBe(false);
    }
    // Missing escalation candidate, no stored prompt, in-flight or already retried.
    expect(shouldAutoRetryEscalate({ ...eligible, hasEscalation: false })).toBe(false);
    expect(shouldAutoRetryEscalate({ ...eligible, hasPrompt: false })).toBe(false);
    expect(shouldAutoRetryEscalate({ ...eligible, autoRetrying: true })).toBe(false);
    expect(shouldAutoRetryEscalate({ ...eligible, retried: true })).toBe(false);
  });
});
