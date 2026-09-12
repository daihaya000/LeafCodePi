import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { AUTO_AGENT_VALUE, DEFAULT_AGENT, resolveAgentSelection } from "./default-agent";

describe("resolveAgentSelection", () => {
  it("prefers builder and rejects the display placeholder", () => {
    assert.equal(resolveAgentSelection("エージェント", ["builder", "programmer"]), DEFAULT_AGENT);
    assert.equal(resolveAgentSelection("", ["programmer", "builder"]), DEFAULT_AGENT);
    assert.equal(resolveAgentSelection("", ["programmer"]), "programmer");
    assert.equal(resolveAgentSelection("", []), DEFAULT_AGENT);
  });

  it("keeps a valid explicit agent", () => {
    assert.equal(resolveAgentSelection("reviewer", ["builder", "reviewer"]), "reviewer");
  });

  it("keeps the Auto sentinel separate from real agents", () => {
    assert.equal(resolveAgentSelection(AUTO_AGENT_VALUE, ["builder", "reviewer"]), AUTO_AGENT_VALUE);
  });
});
