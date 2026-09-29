import { describe, expect, it } from "vitest";
import { messageModelLabel, messageModelLabels } from "./message-model-label";
import type { ModelOption } from "./types";

const model = (value: string, label: string, accountId?: string): ModelOption => ({
  value,
  label,
  providerID: "anthropic",
  modelID: "claude-sonnet-5-5",
  ...(accountId ? { accountId } : {}),
});

describe("message model labels", () => {
  it("uses the picker label for account-prefixed options and the matching historical account", () => {
    const labels = messageModelLabels([
      model("account-a::anthropic::claude-sonnet-5-5", "Claude Sonnet 5.5 (A)", "account-a"),
      model("account-b::anthropic::claude-sonnet-5-5", "Claude Sonnet 5.5 (B)", "account-b"),
    ]);
    expect(messageModelLabel({ provider: "anthropic", model: "claude-sonnet-5-5", accountId: "account-b" }, labels)).toBe("Claude Sonnet 5.5 (B)");
  });

  it("prefers the account-free option when the message has no account", () => {
    const labels = messageModelLabels([
      model("account-a::anthropic::claude-sonnet-5-5", "Account model", "account-a"),
      model("anthropic::claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ]);
    expect(messageModelLabel({ provider: "anthropic", model: "claude-sonnet-5-5" }, labels)).toBe("Claude Sonnet 5.5");
    expect(messageModelLabel({ provider: "anthropic", model: "claude-sonnet-5-5", accountId: "account-a" }, labels)).toBe("Account model");
  });

  it("keeps the raw model ID when the picker no longer lists it", () => {
    expect(messageModelLabel({ provider: "anthropic", model: "retired-model" }, messageModelLabels([]))).toBe("retired-model");
    expect(messageModelLabel({ model: "claude-sonnet-5-5" }, messageModelLabels([]))).toBeUndefined();
  });
});
