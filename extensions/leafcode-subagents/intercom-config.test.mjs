import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = dirname(fileURLToPath(import.meta.url));

function readAgentFrontmatter(agentsDir, name) {
  const text = readFileSync(resolve(agentsDir, name), "utf8");
  return {
    text,
    frontmatter: parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]),
  };
}

test("LeafCode agents can load intercom without disabling ambient extensions", () => {
  const agentsDir = resolve(root, "agents");
  const files = readdirSync(agentsDir).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 15);
  for (const name of files) {
    const { text, frontmatter } = readAgentFrontmatter(agentsDir, name);
    const tools = frontmatter.tools.split(",").map((tool) => tool.trim());
    assert.equal(tools.filter((tool) => tool === "intercom").length, 1, name);
    assert.equal(frontmatter.extensions, undefined, name);
    const entry = resolve(agentsDir, frontmatter.subagentOnlyExtensions);
    assert.equal(entry, resolve(root, "../leafcode-intercom/index.ts"), name);
    assert.match(readFileSync(entry, "utf8"), /export default function/);
    assert.match(text, /Parent decisions stay on contact_supervisor/, name);
    assert.match(text, /never grant authority/, name);
    assert.match(text, /Do not open project panes or send secrets/, name);
  }
});

test("role-specific agent allowlists expose write tools only to implementation roles", () => {
  const agentsDir = resolve(root, "agents");
  const writableRoles = new Set([
    "build", "debugger", "delegate", "docs-writer", "lead-programmer", "programmer", "retrospective", "scout", "test-writer", "worker",
  ]);
  const readOnlyRoles = new Set([
    "code-reviewer", "critical-architect", "finance-expert", "oracle", "plan", "researcher", "reviewer",
    "security-auditor", "ui-ux-designer", "ui-ux-reviewer",
  ]);
  const files = [
    ...readdirSync(agentsDir).filter((name) => name.endsWith(".md")),
    ...readdirSync(resolve(agentsDir, "preset"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `preset/${name}`),
  ];
  for (const name of files) {
    const { frontmatter } = readAgentFrontmatter(agentsDir, name);
    const tools = frontmatter.tools.split(",").map((tool) => tool.trim());
    assert.ok(writableRoles.has(frontmatter.name) || readOnlyRoles.has(frontmatter.name), `${name} must have a role policy`);
    if (writableRoles.has(frontmatter.name)) {
      assert.ok(tools.includes("write") || tools.includes("edit"), `${name} must be writable`);
    }
    if (readOnlyRoles.has(frontmatter.name)) {
      assert.equal(tools.includes("write") || tools.includes("edit"), false, `${name} must remain read-only`);
    }
  }
});
