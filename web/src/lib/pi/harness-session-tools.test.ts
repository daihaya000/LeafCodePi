import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import { isReplacedPackageSource, keepsLoadedExtension, replacedUpstreamPackages, sessionToolNames } from "./harness";

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
    assert.ok(windows.includes("jev_judge"));
    for (const tool of ["web_search", "source_check", "fetch_content", "get_search_content", "intercom"]) {
      assert.ok(windows.includes(tool));
      assert.deepEqual(sessionToolNames({ agentTools: ["read", tool] }), ["read", tool, "tool_search"]);
    }

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

describe("session extension replacement", () => {
  const bundled = (...names: string[]) => ({
    names: new Set(names),
    paths: new Set(names.map((name) => resolve(`/repo/extensions/${name}/index.ts`))),
  });

  it("skips discovery only for the npm packages a bundled fork replaces", () => {
    assert.deepEqual(
      [...replacedUpstreamPackages(new Set(["leafcode-intercom", "leafcode-mcp-adapter"]))],
      ["pi-intercom", "pi-mcp-adapter"],
    );
    // The subagents fork keeps its upstream discoverable; only loaded copies are dropped.
    assert.deepEqual([...replacedUpstreamPackages(new Set(["leafcode-subagents"]))], []);
    assert.deepEqual(
      [...replacedUpstreamPackages(new Set(["leafcode-computer-use"]))],
      ["@injaneity/pi-computer-use"],
    );
    assert.deepEqual([...replacedUpstreamPackages(new Set())], []);
    const names = replacedUpstreamPackages(new Set(["leafcode-computer-use"]));
    assert.equal(isReplacedPackageSource("npm:@injaneity/pi-computer-use@0.5.1", names), true);
    assert.equal(isReplacedPackageSource({ source: "git:github.com/injaneity/pi-computer-use@v0.5.1" }, names), true);
    assert.equal(isReplacedPackageSource("npm:@another/computer-use@0.5.1", names), false);
  });

  it("drops replaced upstreams and stale copies of a bundled extension", () => {
    const index = bundled("leafcode-subagents", "leafcode-intercom");
    assert.equal(keepsLoadedExtension("/npm/pi-subagents/index.js", index), false);
    assert.equal(keepsLoadedExtension("/npm/pi-intercom/index.js", index), false);
    assert.equal(keepsLoadedExtension("/npm/pi-mcp-adapter/index.js", index), true);
    const computerUse = bundled("leafcode-computer-use");
    assert.equal(keepsLoadedExtension("/npm/@injaneity/pi-computer-use/extensions/computer-use.ts", computerUse), false);
    assert.equal(keepsLoadedExtension("/home/.pi/agent/extensions/pi-computer-use.ts", computerUse), false);
    assert.equal(keepsLoadedExtension("/npm/unrelated/computer-use.ts", computerUse), true);
    assert.equal(keepsLoadedExtension("/other/leafcode-subagents/index.ts", index), false);
    assert.equal(
      keepsLoadedExtension(resolve("/repo/extensions/leafcode-subagents/index.ts"), index),
      true,
    );
  });

  it("keeps the upstream extension when its fork is not bundled", () => {
    assert.equal(keepsLoadedExtension("/npm/pi-subagents/index.js", bundled()), true);
  });
});
