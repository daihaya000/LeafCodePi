import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_MODEL_VALUE } from "@/lib/auto-model";
import {
  autoTaskStorageKey,
  clearAutoTaskRecord,
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

  removeItem(key: string): void {
    this.values.delete(key);
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
  agent: "builder",
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

  it("clears a stored Auto record so remount can show a concrete model", () => {
    expect(writeAutoTaskRecord("task-1", record)).toBe(true);
    expect(clearAutoTaskRecord("task-1")).toBe(true);
    expect(readAutoTaskRecord("task-1")).toBeNull();
    expect(sessionStorage.getItem(autoTaskStorageKey("task-1"))).toBeNull();
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
    // Nothing left to fall back to.
    expect(
      resolveModelValue({
        ...input,
        accountTaskModelValue: undefined,
        plainTaskModelValue: "",
        firstModelValue: undefined,
      }),
    ).toBe("");
  });

  it("lets an explicit selection override Auto and the task model", () => {
    // A concrete selection wins even when an Auto record exists, so the user's
    // manual choice is never masked by the Auto sentinel.
    expect(
      resolveModelValue({
        modelSelection: "openai-codex::gpt-5",
        hasAutoRecord: true,
        accountTaskModelValue: "account-1::anthropic::claude-opus-5",
        plainTaskModelValue: "anthropic::claude-opus-5",
        firstModelValue: "anthropic::claude-haiku-4-5",
      }),
    ).toBe("openai-codex::gpt-5");
    // The Auto sentinel itself is also an explicit selection.
    expect(
      resolveModelValue({
        modelSelection: AUTO_MODEL_VALUE,
        hasAutoRecord: false,
        plainTaskModelValue: "anthropic::claude-opus-5",
      }),
    ).toBe(AUTO_MODEL_VALUE);
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

  it("round-trips a decision and survives corrupt or partial payloads", () => {
    // Intelligence variants (including "thinking") must survive a reload.
    for (const variant of ["", "off", "none", "minimal", "thinking", "max"] as const) {
      const next: AutoTaskRecord = {
        ...record,
        decision: { ...record.decision, variant },
      };
      expect(writeAutoTaskRecord("round-trip", next)).toBe(true);
      expect(readAutoTaskRecord("round-trip")?.decision.variant).toBe(variant);
    }

    // Escalation is preserved only when it is well formed.
    const withEscalation: AutoTaskRecord = {
      ...record,
      decision: {
        ...record.decision,
        escalation: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      },
    };
    writeAutoTaskRecord("esc", withEscalation);
    expect(readAutoTaskRecord("esc")?.decision.escalation).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
    });

    // Malformed JSON, non-objects and missing decisions must not throw.
    const storage = globalThis.sessionStorage;
    storage.setItem(autoTaskStorageKey("broken"), "{not json");
    expect(readAutoTaskRecord("broken")).toBeNull();
    storage.setItem(autoTaskStorageKey("array"), "[]");
    expect(readAutoTaskRecord("array")).toBeNull();
    storage.setItem(autoTaskStorageKey("no-decision"), JSON.stringify({ prompt: "x" }));
    expect(readAutoTaskRecord("no-decision")).toBeNull();
    // An escalation missing a modelID is dropped, but the decision survives.
    storage.setItem(
      autoTaskStorageKey("half-esc"),
      JSON.stringify({
        decision: { ...record.decision, escalation: { providerID: "openai" } },
      }),
    );
    expect(readAutoTaskRecord("half-esc")?.decision.escalation).toBeUndefined();
    expect(readAutoTaskRecord("half-esc")?.decision.modelID).toBe(record.decision.modelID);
  });
});
