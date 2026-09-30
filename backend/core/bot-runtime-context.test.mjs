import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { basenameKey, botRuntimeContext, isWebUiRequiredExtension } from "./bot-runtime-context.mjs";

test("an index entry point is identified by its directory, everything else by its stem", () => {
  assert.equal(basenameKey("/x/extensions/leafcode-goal-loop/index.ts"), "leafcode-goal-loop");
  assert.equal(basenameKey("C:\\y\\ext\\thing\\index.mjs"), "thing");
  assert.equal(basenameKey("/x/ext/thing.ts"), "thing");
  assert.equal(basenameKey("/x/ext/thing.js"), "thing");
  assert.equal(basenameKey("/x/ext/thing.cjs"), "thing");
  // Only a bare index file collapses; a differently named file keeps its own stem.
  assert.equal(basenameKey("/x/ext/my-index.ts"), "my-index");
  assert.equal(basenameKey("/x/ext/thing.txt"), "thing.txt");
  assert.equal(basenameKey(""), "");
});

test("only bundled leafcode extensions are application-required", () => {
  assert.equal(isWebUiRequiredExtension("leafcode-goal-loop"), true);
  assert.equal(isWebUiRequiredExtension("leafcode-"), true);
  assert.equal(isWebUiRequiredExtension("goal-loop"), false);
  assert.equal(isWebUiRequiredExtension("leafcode"), false);
  assert.equal(isWebUiRequiredExtension(""), false);
});

test("the runtime context describes this application and lists every loaded extension", () => {
  const text = botRuntimeContext([
    { path: "/repo/extensions/leafcode-goal-loop/index.ts" },
    { path: "/home/u/.pi/agent/extensions/ponytail.ts" },
  ]);
  assert.ok(text.startsWith("<runtime_context>\n"));
  assert.ok(text.endsWith("</runtime_context>"));
  assert.ok(text.includes("You are running inside LeafCodePi Bot"));
  const lines = text.split("\n").filter((line) => line.startsWith("{\"name\""));
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { name: "leafcode-goal-loop", path: "/repo/extensions/leafcode-goal-loop/index.ts", requiredByLeafCode: true },
    { name: "ponytail", path: "/home/u/.pi/agent/extensions/ponytail.ts", requiredByLeafCode: false },
  ]);
  assert.ok(text.includes("LeafCode-required extensions are application dependencies"));
  assert.ok(text.includes("Use jev_judge when a task needs semantic selection"));
});

test("an extension list empty or missing still produces a complete block", () => {
  const empty = botRuntimeContext([]);
  assert.ok(empty.startsWith("<runtime_context>"));
  assert.ok(empty.endsWith("</runtime_context>"));
  assert.equal(empty.includes("\"requiredByLeafCode\""), false);
  assert.ok(botRuntimeContext([]).length > 0);
});

test("the context never claims to list currently callable tools or grants permissions", () => {
  const text = botRuntimeContext([{ path: "/x/a.ts" }]);
  assert.ok(text.includes("Loaded extensions (not a list of currently callable tools):"));
  assert.ok(text.includes("loaded extensions do not grant tool permissions"));
  assert.ok(text.includes("Inferred context does not authorize changes"));
});

test("plain Node builds the context without importing the Web app or the SDK", () => {
  const moduleUrl = new URL("./bot-runtime-context.mjs", import.meta.url).href;
  const code = `
    import { botRuntimeContext, basenameKey } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({ key: basenameKey("/x/pack/index.js"), length: botRuntimeContext([{ path: "/x/pack/index.js" }]).length }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  const result = JSON.parse(output);
  assert.equal(result.key, "pack");
  assert.ok(result.length > 500);
});
