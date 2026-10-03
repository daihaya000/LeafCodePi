import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { isReplacedPackageSource, keepsLoadedExtension, replacedUpstreamPackages } from "./replaced-packages.mjs";

const anthropic = new Set(["@gotgenes/pi-anthropic-auth"]);
const withComputerUse = new Set(["@gotgenes/pi-anthropic-auth", "@injaneity/pi-computer-use"]);
const empty = new Set();

test("an npm entry matches with or without a pinned version, in both entry forms", () => {
  assert.equal(isReplacedPackageSource("npm:@gotgenes/pi-anthropic-auth@3.3.3", anthropic), true);
  assert.equal(isReplacedPackageSource("npm:@gotgenes/pi-anthropic-auth", anthropic), true);
  assert.equal(isReplacedPackageSource({ source: "npm:@gotgenes/pi-anthropic-auth" }, anthropic), true);
  assert.equal(isReplacedPackageSource({ source: "npm:@gotgenes/pi-anthropic-auth@1.0.0" }, anthropic), true);
});

test("only the replaced package name matches, not a lookalike", () => {
  assert.equal(isReplacedPackageSource("npm:@other/pi-anthropic-auth", anthropic), false);
  assert.equal(isReplacedPackageSource("npm:@gotgenes/pi-anthropic-auth-extra", anthropic), false);
  assert.equal(isReplacedPackageSource("npm:pi-anthropic-auth", anthropic), false);
  assert.equal(isReplacedPackageSource("npm:@another/computer-use@0.5.1", withComputerUse), false);
});

test("the computer-use upstream matches only its known owner and repository", () => {
  assert.equal(isReplacedPackageSource("npm:@injaneity/pi-computer-use@0.5.1", withComputerUse), true);
  assert.equal(isReplacedPackageSource({ source: "git:github.com/injaneity/pi-computer-use@v0.5.1" }, withComputerUse), true);
  assert.equal(isReplacedPackageSource("https://github.com/injaneity/pi-computer-use", withComputerUse), true);
  assert.equal(isReplacedPackageSource("git:github.com/someone-else/pi-computer-use", withComputerUse), false);
  assert.equal(isReplacedPackageSource("npm:@injaneity/pi-computer-use@0.5.1", anthropic), false, "without the computer-use upstream nothing is replaced");
  assert.equal(isReplacedPackageSource("git:github.com/injaneity/pi-computer-use", empty), false);
});

test("entries that name nothing are never replaced", () => {
  for (const entry of [undefined, null, 42, true, {}, { source: 42 }, { source: "" }, ""]) {
    assert.equal(isReplacedPackageSource(entry, withComputerUse), false, JSON.stringify(entry ?? null));
  }
});

test("a package whose name carries an @ only as its scope separator is matched whole", () => {
  const scoped = new Set(["@scope/pkg"]);
  assert.equal(isReplacedPackageSource("npm:@scope/pkg", scoped), true);
  assert.equal(isReplacedPackageSource("npm:@scope/pkg@2.0.0", scoped), true);
  assert.equal(isReplacedPackageSource("@scope/pkg", scoped), true, "a git-style entry keeps its name");
});

test("only the forks that skip discovery exclude their upstream package", () => {
  assert.deepEqual([...replacedUpstreamPackages(new Set(["leafcode-intercom"]))], ["pi-intercom", "pi-mcp-adapter"]);
  assert.deepEqual([...replacedUpstreamPackages(new Set(["leafcode-subagents"]))], ["pi-mcp-adapter"], "the subagents fork keeps its upstream discoverable");
  assert.deepEqual([...replacedUpstreamPackages(new Set(["leafcode-computer-use"]))], ["@injaneity/pi-computer-use", "pi-mcp-adapter"]);
  assert.deepEqual([...replacedUpstreamPackages(new Set(["pi-anthropic-auth"]))], ["@gotgenes/pi-anthropic-auth", "pi-mcp-adapter"]);
  assert.deepEqual([...replacedUpstreamPackages(new Set())], ["pi-mcp-adapter"], "the retired MCP upstream is excluded unconditionally");
});

const bundled = (...names) => ({
  names: new Set(names),
  paths: new Set(names.map((name) => resolve(`/repo/extensions/${name}/index.ts`))),
});

test("a replaced upstream and a stale copy of a bundled extension are dropped", () => {
  const index = bundled("leafcode-subagents", "leafcode-intercom");
  assert.equal(keepsLoadedExtension("/npm/pi-subagents/index.js", index), false);
  assert.equal(keepsLoadedExtension("/npm/pi-intercom/index.js", index), false);
  assert.equal(keepsLoadedExtension("/npm/pi-mcp-adapter/index.js", index), false, "the retired MCP upstream is never loaded");
  assert.equal(keepsLoadedExtension("/npm/leafcode-mcp-adapter/index.js", index), false, "a stale copy of the retired fork is never loaded");
  assert.equal(keepsLoadedExtension("/other/leafcode-subagents/index.ts", index), false);
  assert.equal(keepsLoadedExtension(resolve("/repo/extensions/leafcode-subagents/index.ts"), index), true, "the bundled copy itself is kept");
});

test("the bundled computer-use fork drops its upstream by package name or path", () => {
  const computerUse = bundled("leafcode-computer-use");
  assert.equal(keepsLoadedExtension("/npm/@injaneity/pi-computer-use/extensions/computer-use.ts", computerUse), false);
  assert.equal(keepsLoadedExtension("/home/.pi/agent/extensions/pi-computer-use.ts", computerUse), false);
  assert.equal(keepsLoadedExtension("/npm/unrelated/computer-use.ts", computerUse), true);
});

test("an index.ts entry point is matched through its package directory", () => {
  const memory = { names: new Set(["leafcode-memory"]), paths: new Set([resolve("/repo/extensions/leafcode-memory/src/index.ts")]) };
  assert.equal(keepsLoadedExtension("/other/leafcode-memory/src/index.ts", memory), false);
  assert.equal(keepsLoadedExtension(resolve("/repo/extensions/leafcode-memory/src/index.ts"), memory), true);
  assert.equal(keepsLoadedExtension(resolve("/repo/extensions/leafcode-memory/src/other.ts"), memory), false);
});
