import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = dirname(fileURLToPath(import.meta.url));

test("LeafCode agents can load intercom without disabling ambient extensions", () => {
  const agentsDir = resolve(root, "agents");
  const files = readdirSync(agentsDir).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 15);
  for (const name of files) {
    const text = readFileSync(resolve(agentsDir, name), "utf8");
    const frontmatter = parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
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
