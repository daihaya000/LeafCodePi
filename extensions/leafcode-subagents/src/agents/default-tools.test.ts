import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => fixture.home,
}));
import { discoverAgents, discoverAgentsAll, mergeBuiltinAgentOverride, removeBuiltinAgentOverride, removeBuiltinAgentOverrideFields } from "./agents";

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
  it("merges WebUI sidecar overrides over legacy user settings and accepts reset tombstones", () => {
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({
      packages: [],
      subagents: { agentOverrides: { programmer: { model: "legacy-model", thinking: "high", disabled: true } } },
    }), "utf8");
    writeFileSync(join(root, "agent", "agent-overrides.json"), JSON.stringify({
      version: 1,
      overrides: { programmer: { model: null, thinking: null, disabled: false } },
    }), "utf8");

    const programmer = discoverAgentsAll(root).builtin.find((agent) => agent.name === "programmer");
    assert.ok(programmer);
    assert.notEqual(programmer.model, "legacy-model");
    assert.notEqual(programmer.thinking, "high");
    assert.equal(programmer.disabled, false);
  });

  it("writes user builtin overrides to the shared sidecar and masks legacy fields when resetting", () => {
    const settingsPath = join(root, "agent", "settings.json");
    const sidecarPath = join(root, "agent", "agent-overrides.json");
    writeFileSync(settingsPath, JSON.stringify({
      packages: [],
      subagents: { agentOverrides: { programmer: { model: "legacy-model", thinking: "high", disabled: true } } },
    }), "utf8");
    const settingsBefore = readFileSync(settingsPath, "utf8");

    assert.equal(mergeBuiltinAgentOverride(root, "programmer", "user", { model: "native-model" }), sidecarPath);
    assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
    assert.equal(JSON.parse(readFileSync(sidecarPath, "utf8")).overrides.programmer.model, "native-model");
    assert.equal(discoverAgentsAll(root).builtin.find((agent) => agent.name === "programmer")?.model, "native-model");

    const fieldReset = removeBuiltinAgentOverrideFields(root, "programmer", "user", ["model"]);
    assert.equal(fieldReset.path, sidecarPath);
    assert.equal(fieldReset.removed, true);
    assert.equal(JSON.parse(readFileSync(sidecarPath, "utf8")).overrides.programmer.model, null);
    assert.notEqual(discoverAgentsAll(root).builtin.find((agent) => agent.name === "programmer")?.model, "legacy-model");

    const fullReset = removeBuiltinAgentOverride(root, "programmer", "user");
    assert.equal(fullReset.path, sidecarPath);
    assert.equal(fullReset.removed, true);
    assert.notEqual(discoverAgentsAll(root).builtin.find((agent) => agent.name === "programmer")?.disabled, true);
    assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
  });

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
