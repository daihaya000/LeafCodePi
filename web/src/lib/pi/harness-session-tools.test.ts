import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { sessionToolNames } from "./harness";

describe("sessionToolNames", () => {
  it("registers the WebUI defaults with the platform shell and no subagent by default", () => {
    const linux = sessionToolNames({ platform: "linux" });
    assert.ok(linux.includes("bash"));
    assert.equal(linux.includes("powershell"), false);
    assert.equal(linux.includes("subagent"), false);
    assert.ok(linux.includes("tool_search"));

    const windows = sessionToolNames({ platform: "win32" });
    assert.ok(windows.includes("powershell"));
    assert.ok(windows.includes("bash"));

    assert.ok(
      sessionToolNames({ platform: "linux", subagentPermission: "allow" }).includes("subagent"),
    );
  });

  it("keeps an agent allowlist, adding tool_search only for deferred tools", () => {
    assert.deepEqual(sessionToolNames({ platform: "linux", agentTools: ["read", "grep"] }), [
      "read",
      "grep",
    ]);
    assert.deepEqual(sessionToolNames({ platform: "linux", agentTools: ["read", "bash"] }), [
      "read",
      "bash",
      "tool_search",
    ]);
  });

  it("registers every Bot tool and appends the session-scoped tools once", () => {
    const botTools = sessionToolNames({
      platform: "linux",
      botTools: ["read"],
      botSoulTool: true,
      botCodeTool: true,
      roomHandoffTool: true,
    });
    assert.equal(botTools.includes("powershell"), false);
    assert.ok(botTools.includes("update_soul"));
    assert.ok(botTools.includes("code_session"));
    assert.ok(botTools.includes("room_handoff"));
    assert.equal(new Set(botTools).size, botTools.length);
  });
});
