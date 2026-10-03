import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => fixture.home,
}));
import { discoverAgents, discoverAgentsAll } from "./agents";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-default-tools-"));
  fixture.home = root;
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_SUBAGENT_EXTRA_AGENT_DIRS", "");
  mkdirSync(join(root, "agent", "agents"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const definition = (name: string) => `---\nname: ${name}\ndescription: fixture\ntools: read\n---\n`;

describe("default dynamically inherits tools in subagent discovery", () => {
  it.each([false, ["read"], "inherit"])("ignores old default tools override %j for builtin and user definitions", (tools) => {
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({
      packages: [], subagents: { agentOverrides: { default: { tools }, programmer: { tools: ["read"] } } },
    }), "utf8");
    const builtin = discoverAgentsAll(root).builtin.find((agent) => agent.name === "default");
    assert.ok(builtin);
    assert.equal(builtin.tools, undefined);
    assert.equal(builtin.mcpDirectTools, undefined);
    writeFileSync(join(root, "agent", "agents", "default.md"), definition("default"), "utf8");
    writeFileSync(join(root, "agent", "agents", "limited.md"), definition("limited"), "utf8");
    const agents = discoverAgents(root, "user").agents;
    const selected = agents.find((agent) => agent.name === "default");
    assert.ok(selected);
    assert.equal(selected.source, "user");
    assert.equal(selected.tools, undefined);
    assert.deepEqual(agents.find((agent) => agent.name === "limited")?.tools, ["read"]);
    assert.deepEqual(agents.find((agent) => agent.name === "programmer")?.tools, ["read"]);
  });
});
