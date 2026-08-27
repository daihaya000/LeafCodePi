import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DEFAULT_AGENT, resolveAgentSelection } from "./default-agent";

describe("resolveAgentSelection", () => {
  it("prefers build and rejects the display placeholder", () => {
    assert.equal(resolveAgentSelection("エージェント", ["build", "programmer"]), DEFAULT_AGENT);
    assert.equal(resolveAgentSelection("", ["programmer", "build"]), DEFAULT_AGENT);
    assert.equal(resolveAgentSelection("", ["programmer"]), "programmer");
    assert.equal(resolveAgentSelection("", []), DEFAULT_AGENT);
  });

  it("keeps a valid explicit agent", () => {
    assert.equal(resolveAgentSelection("reviewer", ["build", "reviewer"]), "reviewer");
  });
});
