import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { agentsDir, AgentsError, agentsErrorStatus, createAgent, deleteAgent, listAgents, parseAgentFile, readUserAgent, serializeAgent, setAgentEnabled, updateAgent } from "./agents";

const AGENT = `---
name: __NAME__
description: Code review and small fixes
tools: read, grep, find, ls
---

Review the diff.
`;

function agentNamed(name: string): string {
  return AGENT.replace("__NAME__", name);
}

describe("agentsDir", () => {
  it("lives in the Pi agent dir", () => {
    assert.equal(agentsDir("C:\\pi\\agent"), "C:\\pi\\agent\\agents");
  });
});

describe("parseAgentFile", () => {
  it("parses YAML frontmatter", () => {
    const fm = parseAgentFile(agentNamed("reviewer"));
    assert.equal(fm.name, "reviewer");
    assert.equal(fm.description, "Code review and small fixes");
    assert.equal(fm.tools, "read, grep, find, ls");
  });

  it("returns empty for no frontmatter", () => {
    assert.deepEqual(parseAgentFile("no frontmatter"), {});
  });

  it("returns empty for invalid YAML", () => {
    assert.deepEqual(parseAgentFile("---\nname: [unclosed\n---\n"), {});
  });
});

describe("listAgents / setAgentEnabled", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  function fixture() {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-agent-"));
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "scout.md"), agentNamed("scout"), "utf8");
    writeFileSync(join(agentDir, "agents", "researcher.md"), agentNamed("researcher"), "utf8");
    // A builtin/package agent dir under a fake package
    const pkg = join(agentDir, "npm", "node_modules", "pi-subagents", "agents");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "worker.md"), agentNamed("worker"), "utf8");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-subagents"] }),
      "utf8",
    );
    return { agentDir };
  }

  it("lists user and package agents", () => {
    fixture();
    const result = listAgents(agentDir);
    const byName = new Map(result.agents.map((a) => [a.name, a]));
    assert.equal(byName.has("scout"), true);
    assert.equal(byName.has("worker"), true);
    assert.equal(byName.get("scout")?.enabled, true);
    assert.equal(result.agentsDir, join(agentDir, "agents"));
  });

  it("user agents override package same-name", () => {
    fixture();
    // Add a user agent with same name as package builtin
    writeFileSync(join(agentDir, "agents", "worker.md"), agentNamed("worker"), "utf8");
    const result = listAgents(agentDir);
    const worker = result.agents.find((a) => a.name === "worker");
    assert.equal(worker?.source, "user");
  });

  it("disables and enables an agent via settings overrides", () => {
    fixture();
    setAgentEnabled("scout", false, agentDir);
    assert.equal(listAgents(agentDir).agents.find((a) => a.name === "scout")?.enabled, false);

    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.equal(raw.subagents.agentOverrides.scout.disabled, true);

    setAgentEnabled("scout", true, agentDir);
    assert.equal(listAgents(agentDir).agents.find((a) => a.name === "scout")?.enabled, true);
    const raw2 = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.equal(raw2.subagents?.agentOverrides?.scout, undefined);
  });

  it("rejects unknown names", () => {
    fixture();
    assert.throws(() => setAgentEnabled("missing", false, agentDir), AgentsError);
  });

  it("creates, reads, updates and deletes a user agent", () => {
    fixture();
    createAgent({ name: "mydoc", description: "A doc writer", tools: ["read", "edit", "write"], systemPrompt: "Write docs." }, agentDir);
    assert.equal(listAgents(agentDir).agents.find((a) => a.name === "mydoc")?.source, "user");

    const { draft } = readUserAgent("mydoc", agentDir);
    assert.equal(draft.description, "A doc writer");
    assert.deepEqual(draft.tools, ["read", "edit", "write"]);
    assert.equal(draft.systemPrompt, "Write docs.");

    updateAgent({ name: "mydoc", description: "Docs writer v2", systemPrompt: "Write great docs." }, agentDir);
    const updated = readUserAgent("mydoc", agentDir).draft;
    assert.equal(updated.description, "Docs writer v2");
    assert.equal(updated.systemPrompt, "Write great docs.");

    deleteAgent("mydoc", agentDir);
    assert.equal(listAgents(agentDir).agents.some((a) => a.name === "mydoc"), false);
  });

  it("rejects creating a duplicate name", () => {
    fixture();
    createAgent({ name: "brand-new", systemPrompt: "x" }, agentDir);
    assert.throws(() => createAgent({ name: "brand-new", systemPrompt: "y" }, agentDir), /既に存在/);
  });

  it("rejects editing a package agent", () => {
    fixture();
    assert.throws(() => updateAgent({ name: "worker", systemPrompt: "x" }, agentDir), /編集できません/);
    assert.throws(() => deleteAgent("worker", agentDir), /編集できません/);
  });

  it("serializes frontmatter and round-trips", () => {
    const md = serializeAgent({
      name: "foo",
      description: "Foo agent",
      aliases: ["bar"],
      tools: ["read", "grep"],
      systemPrompt: "Do foo.",
    });
    const fm = parseAgentFile(md);
    assert.equal(fm.name, "foo");
    assert.equal(fm.description, "Foo agent");
    assert.equal(fm.tools, "read, grep");
    assert.match(md, /Do foo\.\n$/);
  });
});

describe("agentsErrorStatus", () => {
  it("maps invalid-name to 400 and not-found to 404", () => {
    assert.equal(agentsErrorStatus(new AgentsError("invalid-name", "x")), 400);
    assert.equal(agentsErrorStatus(new AgentsError("not-found", "x")), 404);
    assert.equal(agentsErrorStatus(new Error("boom")), 500);
  });
});
