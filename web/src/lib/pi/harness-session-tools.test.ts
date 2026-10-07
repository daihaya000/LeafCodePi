import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it, vi } from "vitest";
import { isReplacedPackageSource, keepsLoadedExtension, replacedUpstreamPackages, sessionExtensionFactories, sessionExtensionsOverride, sessionToolNames } from "./harness";
import { COMPUTER_USE_TOOL_NAMES } from "./deferred-tools";

describe("sessionToolNames", () => {
  it("registers the WebUI defaults with the platform shell and no subagent by default", () => {
    const linux = sessionToolNames({ platform: "linux" });
    assert.ok(linux.includes("bash"));
    assert.equal(linux.includes("powershell"), false);
    assert.equal(linux.includes("subagent"), false);
    assert.equal(sessionToolNames({ platform: "linux", env: {} }).includes("act_ui"), false);
    assert.ok(sessionToolNames({ platform: "linux", env: { DISPLAY: ":0" } }).includes("act_ui"));
    assert.ok(sessionToolNames({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }).includes("act_ui"));
    assert.equal(sessionToolNames({ platform: "darwin" }).includes("act_ui"), false);
    assert.ok(linux.includes("tool_search"));
    assert.ok(linux.includes("codemode"));
    assert.ok(linux.includes("session_resume"));
    for (const name of ["show_image", "show_video", "show_audio"]) assert.ok(linux.includes(name));
    assert.deepEqual(sessionToolNames({ agentTools: ["read", "session_resume"] }), ["read", "session_resume"]);

    const windows = sessionToolNames({ platform: "win32" });
    assert.ok(windows.includes("powershell"));
    assert.ok(windows.includes("bash"));
    assert.ok(windows.includes("jev_judge"));
    assert.ok(windows.includes("codemode"));
    assert.ok(sessionToolNames({ platform: "darwin" }).includes("codemode"));
    for (const tool of COMPUTER_USE_TOOL_NAMES) {
      assert.ok(windows.includes(tool));
      assert.deepEqual(sessionToolNames({ agentTools: ["read", tool] }), ["read", tool]);
    }
    for (const tool of ["web_search", "source_check", "fetch_content", "get_search_content", "intercom"]) {
      assert.ok(windows.includes(tool));
      assert.deepEqual(sessionToolNames({ agentTools: ["read", tool] }), ["read", tool]);
    }

    assert.ok(
      sessionToolNames({ platform: "linux", subagentPermission: "allow" }).includes("subagent"),
    );
  });

  it("keeps an agent allowlist without implicitly granting tool_search or codemode", () => {
    for (const name of ["show_image", "show_video", "show_audio"]) {
      assert.deepEqual(sessionToolNames({ agentTools: ["read", name] }), ["read", name]);
    }
    assert.deepEqual(sessionToolNames({ platform: "linux", agentTools: ["read", "grep"] }), [
      "read",
      "grep",
    ]);
    assert.deepEqual(sessionToolNames({ platform: "linux", agentTools: ["read", "bash"] }), [
      "read",
      "bash",
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
    assert.equal(botTools.includes("act_ui"), false);
    assert.equal(botTools.includes("codemode"), false);
    for (const name of ["show_image", "show_video", "show_audio"]) assert.ok(botTools.includes(name));
    assert.ok(botTools.includes("update_soul"));
    assert.ok(botTools.includes("code_session"));
    assert.ok(botTools.includes("room_handoff"));
    assert.equal(new Set(botTools).size, botTools.length);
  });
});

describe("default tool reload policy", () => {
  it("keeps a denied subagent disabled across reload without dropping a new tool", () => {
    let active = ["read", "subagent"];
    const handlers = new Map<string, () => void>();
    const api = {
      on: (name: string, handler: () => void) => { handlers.set(name, handler); },
      getActiveTools: () => active,
      setActiveTools: (tools: string[]) => { active = tools; },
    } as never;
    const factory = sessionExtensionFactories({ agentDir: "/fixture", hasBotSkills: false, allTools: true, getExtensions: () => [] })[0];
    factory(api);
    handlers.get("session_start")!();
    assert.deepEqual(active, ["read", "subagent"]);
    active = ["read"]; // An explicit permission update after initial binding.
    handlers.get("session_shutdown")!();
    active = ["read", "subagent", "future_tool"]; // SDK reload activates extension defaults.
    factory(api);
    handlers.get("session_start")!();
    assert.deepEqual(active, ["read", "future_tool"]);
    active.push("subagent"); // Re-enabling the permission is also preserved.
    handlers.get("session_shutdown")!();
    factory(api);
    handlers.get("session_start")!();
    assert.ok(active.includes("subagent"));
  });
});

describe("session extension replacement", () => {
  const bundled = (...names: string[]) => ({
    names: new Set(names),
    paths: new Set(names.map((name) => resolve(`/repo/extensions/${name}/index.ts`))),
  });

  it("skips replaced upstreams and directly integrated providers", () => {
    const integrated = ["pi-mcp-adapter", "pi-commandcode-provider"];
    assert.deepEqual(
      [...replacedUpstreamPackages(new Set(["leafcode-intercom"]))],
      ["pi-intercom", ...integrated],
    );
    // The subagents fork keeps its upstream discoverable; only loaded copies are dropped.
    assert.deepEqual([...replacedUpstreamPackages(new Set(["leafcode-subagents"]))], integrated);
    assert.deepEqual(
      [...replacedUpstreamPackages(new Set(["leafcode-computer-use"]))],
      ["@injaneity/pi-computer-use", ...integrated],
    );
    assert.deepEqual([...replacedUpstreamPackages(new Set())], integrated, "retired MCP and integrated providers stay excluded");
    const anthropic = replacedUpstreamPackages(new Set(["pi-anthropic-auth"]));
    assert.deepEqual([...anthropic], ["@gotgenes/pi-anthropic-auth", ...integrated]);
    assert.equal(isReplacedPackageSource("npm:@gotgenes/pi-anthropic-auth@3.3.3", anthropic), true);
    assert.equal(isReplacedPackageSource({ source: "npm:@gotgenes/pi-anthropic-auth" }, anthropic), true);
    assert.equal(isReplacedPackageSource("npm:@other/pi-anthropic-auth", anthropic), false);
    const names = replacedUpstreamPackages(new Set(["leafcode-computer-use"]));
    assert.equal(isReplacedPackageSource("npm:@injaneity/pi-computer-use@0.5.1", names), true);
    assert.equal(isReplacedPackageSource({ source: "git:github.com/injaneity/pi-computer-use@v0.5.1" }, names), true);
    assert.equal(isReplacedPackageSource("npm:@another/computer-use@0.5.1", names), false);
  });

  it("drops replaced upstreams and stale copies of a bundled extension", () => {
    const index = bundled("leafcode-subagents", "leafcode-intercom");
    assert.equal(keepsLoadedExtension("/npm/pi-subagents/index.js", index), false);
    assert.equal(keepsLoadedExtension("/npm/pi-intercom/index.js", index), false);
    assert.equal(keepsLoadedExtension("/npm/pi-mcp-adapter/index.js", index), false, "the retired MCP upstream is never loaded");
    const computerUse = bundled("leafcode-computer-use");
    assert.equal(keepsLoadedExtension("/npm/@injaneity/pi-computer-use/extensions/computer-use.ts", computerUse), false);
    assert.equal(keepsLoadedExtension("/home/.pi/agent/extensions/pi-computer-use.ts", computerUse), false);
    assert.equal(keepsLoadedExtension("/npm/unrelated/computer-use.ts", computerUse), true);
    assert.equal(keepsLoadedExtension("/other/leafcode-subagents/index.ts", index), false);
    assert.equal(
      keepsLoadedExtension(resolve("/repo/extensions/leafcode-subagents/index.ts"), index),
      true,
    );
    const memoryEntry = resolve("/repo/extensions/leafcode-memory/src/index.ts");
    const memory = { names: new Set(["leafcode-memory"]), paths: new Set([memoryEntry]) };
    assert.equal(keepsLoadedExtension("/other/leafcode-memory/src/index.ts", memory), false);
    assert.equal(keepsLoadedExtension(memoryEntry, memory), true);
    assert.equal(keepsLoadedExtension("/other/unrelated/src/index.ts", memory), true);
    const anthropic = bundled("pi-anthropic-auth");
    const npmAuth = "/npm/@gotgenes/pi-anthropic-auth/src/index.ts";
    assert.equal(keepsLoadedExtension(npmAuth, anthropic), false);
    assert.equal(keepsLoadedExtension("/other/pi-anthropic-auth/index.ts", anthropic), false);
    assert.equal(keepsLoadedExtension(resolve("/repo/extensions/pi-anthropic-auth/index.ts"), anthropic), true);
    assert.equal(keepsLoadedExtension(npmAuth, bundled()), true);
  });

  it("never loads a global Command Code extension over the integrated runtime provider", () => {
    const names = replacedUpstreamPackages(new Set());
    assert.equal(isReplacedPackageSource("npm:pi-commandcode-provider@0.7.6", names), true);
    assert.equal(isReplacedPackageSource({ source: "npm:pi-commandcode-provider" }, names), true);
    assert.equal(keepsLoadedExtension("/npm/pi-commandcode-provider/index.ts", bundled()), false);
    const override = sessionExtensionsOverride(bundled());
    const extensions = [{ path: "/npm/pi-commandcode-provider/index.ts" }, { path: "/npm/unrelated/index.ts" }];
    assert.deepEqual(override({ extensions, errors: [] } as unknown as Parameters<typeof override>[0]).extensions.map((entry) => entry.path), ["/npm/unrelated/index.ts"]);
  });

  it("keeps the upstream extension when its fork is not bundled", () => {
    assert.equal(keepsLoadedExtension("/npm/pi-subagents/index.js", bundled()), true);
  });

  it("logs load failures of kept extensions once, first line only", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const webAccess = resolve("/repo/extensions/leafcode-web-access/index.ts");
      const override = sessionExtensionsOverride(bundled("leafcode-intercom", "leafcode-web-access"));
      const base = {
        extensions: [{ path: webAccess }, { path: "/npm/pi-intercom/index.js" }],
        errors: [
          { path: webAccess, error: "Failed to load extension: Cannot find module 'linkedom'\r\nRequire stack:\n- duckduckgo.ts" },
          { path: "/npm/pi-intercom/index.js", error: "Failed to load extension: replaced upstream" },
        ],
      } as unknown as Parameters<typeof override>[0];
      assert.deepEqual(override(base).extensions.map(({ path }) => path), [webAccess]);
      override(base);
      assert.deepEqual(logged.mock.calls, [
        [`[extensions] ${webAccess}: Failed to load extension: Cannot find module 'linkedom'`],
      ]);
    } finally {
      logged.mockRestore();
    }
  });
});
