import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  AUTO_AGENT_VALUE,
  DEFAULT_AGENT,
  hasMultipleAgentChoices,
  isAutoAgentEnabled,
  resolveAgentSelection,
} from "./default-agent";

describe("hasMultipleAgentChoices", () => {
  it("shows the selector only with at least two enabled choices, counting Auto when enabled", () => {
    assert.equal(hasMultipleAgentChoices(0, false), false);
    assert.equal(hasMultipleAgentChoices(1, false), false);
    assert.equal(hasMultipleAgentChoices(1, true), true);
    assert.equal(hasMultipleAgentChoices(2, false), true);
  });
});

describe("resolveAgentSelection", () => {
  it("prefers default and rejects the display placeholder", () => {
    assert.equal(resolveAgentSelection("エージェント", ["default", "builder", "programmer"]), DEFAULT_AGENT);
    assert.equal(resolveAgentSelection("", ["programmer", "builder", "default"]), DEFAULT_AGENT);
    assert.equal(resolveAgentSelection("", ["programmer"]), "programmer");
    assert.equal(resolveAgentSelection("", []), DEFAULT_AGENT);
  });

  it("keeps a valid explicit agent", () => {
    assert.equal(resolveAgentSelection("reviewer", ["builder", "reviewer"]), "reviewer");
  });

  it("keeps the Auto sentinel separate from real agents", () => {
    assert.equal(resolveAgentSelection(AUTO_AGENT_VALUE, ["builder", "reviewer"], true), AUTO_AGENT_VALUE);
  });

  it("disables Auto by default", () => {
    assert.equal(resolveAgentSelection(AUTO_AGENT_VALUE, ["builder", "reviewer"]), "builder");
    assert.equal(isAutoAgentEnabled(null), false);
    assert.equal(isAutoAgentEnabled("0"), false);
    assert.equal(isAutoAgentEnabled("1"), true);
  });

  it("falls back from Auto when Auto is disabled", () => {
    assert.equal(resolveAgentSelection(AUTO_AGENT_VALUE, ["builder", "reviewer"], false), "builder");
  });
});
