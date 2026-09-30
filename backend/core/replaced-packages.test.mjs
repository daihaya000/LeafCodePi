import assert from "node:assert/strict";
import { test } from "node:test";
import { isReplacedPackageSource } from "./replaced-packages.mjs";

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