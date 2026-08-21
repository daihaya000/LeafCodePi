import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { applySubagentPermission, decoratePrompt } from "./harness";

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

describe("applySubagentPermission", () => {
  function mockSession(initial: string[]) {
    let names = [...initial];
    return {
      getActiveToolNames: () => [...names],
      setActiveToolsByName: (next: string[]) => {
        names = [...next];
      },
      names: () => [...names],
    };
  }

  it("adds subagent when allow and absent", () => {
    const s = mockSession(["read", "bash"]);
    applySubagentPermission(s as never, "allow");
    assert.deepEqual(s.names(), ["read", "bash", "subagent"]);
  });

  it("removes subagent when deny and present", () => {
    const s = mockSession(["read", "bash", "subagent"]);
    applySubagentPermission(s as never, "deny");
    assert.deepEqual(s.names(), ["read", "bash"]);
  });

  it("defaults to deny when undefined", () => {
    const s = mockSession(["read", "bash", "subagent"]);
    applySubagentPermission(s as never, undefined);
    assert.deepEqual(s.names(), ["read", "bash"]);
  });

  it("is idempotent", () => {
    const s = mockSession(["read", "bash"]);
    applySubagentPermission(s as never, "deny");
    assert.deepEqual(s.names(), ["read", "bash"]);
  });
});
