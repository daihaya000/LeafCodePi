import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { decoratePrompt } from "./harness";

describe("decoratePrompt", () => {
  it("returns the prompt unchanged without options", () => {
    assert.equal(decoratePrompt("Do the thing"), "Do the thing");
  });

  it("prepends an agent delegation instruction", () => {
    const result = decoratePrompt("Fix the bug", { agent: "worker" });
    assert.match(result, /サブエージェント「worker」に委譲/);
    assert.match(result, /agent: "worker"/);
    assert.ok(result.endsWith("Fix the bug"));
  });

  it("prepends a subagent deny instruction", () => {
    const result = decoratePrompt("Fix the bug", { subagentPermission: "deny" });
    assert.match(result, /禁止されています/);
    assert.ok(result.endsWith("Fix the bug"));
  });

  it("combines agent and deny instructions", () => {
    const result = decoratePrompt("Fix", { agent: "scout", subagentPermission: "deny" });
    assert.match(result, /scout/);
    assert.match(result, /禁止されています/);
  });
});
