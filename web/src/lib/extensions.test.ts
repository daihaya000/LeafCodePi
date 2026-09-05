import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  basenameKey,
  extensionsStatePath,
  filterExtensionsByState,
  isExtensionDisabled,
  listExtensions,
  readExtensionsState,
  readPiSettings,
  resolvePackageDir,
  setExtensionEnabled,
  writeExtensionsState,
} from "./extensions";

describe("basenameKey", () => {
  it("strips the extension from a file path", () => {
    assert.equal(basenameKey("C:\\pi\\extensions\\ponytail.js"), "ponytail");
    assert.equal(basenameKey("C:/pi/extensions/ponytail.ts"), "ponytail");
  });

  it("uses the directory name for an index entry", () => {
    assert.equal(basenameKey("C:\\pi\\extensions\\ponytail\\index.js"), "ponytail");
  });

  it("handles trailing separators", () => {
    assert.equal(basenameKey("C:\\pi\\extensions\\ponytail\\"), "ponytail");
  });
});

describe("filterExtensionsByState", () => {
  it("drops disabled extensions by basename", () => {
    const filtered = filterExtensionsByState(
      [
        { path: "C:\\pi\\extensions\\ponytail\\index.js" },
        { path: "C:\\pi\\extensions\\other.js" },
      ],
      { disabled: { ponytail: true } },
    );
    assert.deepEqual(filtered.map((e) => e.path), ["C:\\pi\\extensions\\other.js"]);
  });

  it("keeps everything when nothing is disabled", () => {
    const all = [{ path: "C:\\pi\\extensions\\a.js" }, { path: "C:\\pi\\extensions\\b.js" }];
    assert.deepEqual(filterExtensionsByState(all, { disabled: {} }), all);
  });

  it("keeps required extensions even if stale state tries to disable them", () => {
    const filtered = filterExtensionsByState(
      [
        { path: "C:\\pi\\extensions\\leafcode-goal-loop\\index.ts" },
        { path: "C:\\pi\\extensions\\other.js" },
      ],
      { disabled: { "leafcode-goal-loop": true, other: true } },
    );
    assert.deepEqual(filtered.map((entry) => entry.path), ["C:\\pi\\extensions\\leafcode-goal-loop\\index.ts"]);
  });

  it("keeps leafcode-commit-guard even if stale state tries to disable it", () => {
    const filtered = filterExtensionsByState(
      [
        { path: "C:\\pi\\extensions\\leafcode-commit-guard\\index.ts" },
        { path: "C:\\pi\\extensions\\leafcode-todowrite\\index.ts" },
      ],
      { disabled: { "leafcode-commit-guard": true } },
    );
    assert.deepEqual(filtered.map((entry) => entry.path), [
      "C:\\pi\\extensions\\leafcode-commit-guard\\index.ts",
      "C:\\pi\\extensions\\leafcode-todowrite\\index.ts",
    ]);
  });

  it("keeps settle-followup-claim even if stale state tries to disable it", () => {
    const filtered = filterExtensionsByState(
      [
        { path: "C:\\pi\\extensions\\settle-followup-claim.ts" },
        { path: "C:\\pi\\extensions\\other.js" },
      ],
      { disabled: { "settle-followup-claim": true, other: true } },
    );
    assert.deepEqual(filtered.map((entry) => entry.path), [
      "C:\\pi\\extensions\\settle-followup-claim.ts",
    ]);
  });

  it("drops retired extensions even when no state disables them", () => {
    const filtered = filterExtensionsByState(
      [
        { path: "C:\\pi\\extensions\\leafcode-collaboration\\index.ts" },
        { path: "C:\\pi\\extensions\\other.js" },
      ],
      { disabled: {} },
    );
    assert.deepEqual(filtered.map((entry) => entry.path), ["C:\\pi\\extensions\\other.js"]);
  });
});

describe("listExtensions / setExtensionEnabled", () => {
  let agentDir = "";
  let data = "";
  let prevData: string | undefined;
  let prevExtDir: string | undefined;

  afterEach(() => {
    if (prevData === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = prevData;
    prevData = undefined;
    if (prevExtDir === undefined) delete process.env.LEAFCODE_PI_EXTENSIONS_DIR;
    else process.env.LEAFCODE_PI_EXTENSIONS_DIR = prevExtDir;
    prevExtDir = undefined;
    for (const dir of [agentDir, data]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    agentDir = "";
    data = "";
  });

  function writeExtension(root: string, name: string) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "index.js"), "export default () => {};\n", "utf8");
  }

  function fixture(opts?: { withPonytail?: boolean }) {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-ext-agent-"));
    data = mkdtempSync(join(tmpdir(), "leafcode-pi-ext-data-"));
    prevData = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = data;
    // Keep the real repository's extensions/ out of discovery.
    prevExtDir = process.env.LEAFCODE_PI_EXTENSIONS_DIR;
    process.env.LEAFCODE_PI_EXTENSIONS_DIR = join(data, "no-such-bundled-dir");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    if (opts?.withPonytail) writeExtension(join(agentDir, "extensions"), "ponytail");
    writeFileSync(join(agentDir, "extensions", "one.js"), "export default () => {};\n", "utf8");
    writeExtensionsState({ disabled: {} });
    return { agentDir };
  }

  it("lists discovered extensions as enabled by default", () => {
    const { agentDir: agent } = fixture({ withPonytail: true });
    const listed = listExtensions(agent);
    expectNames(listed.extensions, ["one", "ponytail"]);
    assert.equal(listed.extensions.every((e) => e.enabled), true);
    assert.equal(listed.extensionsDir, join(agent, "extensions"));
  });

  it("hides a retired extension from the extension list", () => {
    const { agentDir: agent } = fixture();
    writeExtension(join(agent, "extensions"), "leafcode-collaboration");

    expect(listExtensions(agent).extensions.map((entry) => entry.name)).not.toContain("leafcode-collaboration");
  });

  it("toggles extensions via extensions-state.json", () => {
    const { agentDir: agent } = fixture({ withPonytail: true });
    let listed = setExtensionEnabled("ponytail", false, agent);
    assert.equal(listed.extensions.find((e) => e.name === "ponytail")?.enabled, false);
    assert.deepEqual(readExtensionsState().disabled, { ponytail: true });
    assert.equal(isExtensionDisabled("ponytail"), true);

    listed = setExtensionEnabled("ponytail", true, agent);
    assert.equal(listed.extensions.find((e) => e.name === "ponytail")?.enabled, true);
    assert.deepEqual(readExtensionsState().disabled, {});
  });

  it("rejects unknown extension names", () => {
    const { agentDir: agent } = fixture();
    assert.throws(() => setExtensionEnabled("missing", false, agent), /見つかりません/);
  });

  it("marks WebUI-required extensions and refuses to disable them", () => {
    const { agentDir: agent } = fixture();
    writeExtension(join(agent, "extensions"), "leafcode-todowrite");
    writeExtension(join(agent, "extensions"), "leafcode-subagents");
    writeExtension(join(agent, "extensions"), "leafcode-custom");
    writeExtension(join(agent, "extensions"), "leafcode-commit-guard");
    writeFileSync(join(agent, "extensions", "settle-followup-claim.ts"), "export {};\n", "utf8");

    const listed = listExtensions(agent);
    const required = listed.extensions.find((e) => e.name === "leafcode-todowrite");
    assert.equal(required?.required, true);
    assert.equal(listed.extensions.find((e) => e.name === "leafcode-subagents")?.required, true);
    assert.equal(listed.extensions.find((e) => e.name === "leafcode-custom")?.required, true);
    assert.equal(listed.extensions.find((e) => e.name === "leafcode-commit-guard")?.required, true);
    assert.equal(listed.extensions.find((e) => e.name === "settle-followup-claim")?.required, true);
    assert.equal(listed.extensions.find((e) => e.name === "one")?.required, false);

    assert.throws(() => setExtensionEnabled("leafcode-todowrite", false, agent), /無効化できません/);
    assert.throws(() => setExtensionEnabled("leafcode-subagents", false, agent), /無効化できません/);
    assert.throws(() => setExtensionEnabled("leafcode-custom", false, agent), /無効化できません/);
    assert.throws(() => setExtensionEnabled("leafcode-commit-guard", false, agent), /無効化できません/);
    assert.throws(() => setExtensionEnabled("settle-followup-claim", false, agent), /無効化できません/);
    // 無効化禁止の後も有効状態は維持される。
    assert.equal(listExtensions(agent).extensions.find((e) => e.name === "leafcode-todowrite")?.enabled, true);
    assert.equal(listExtensions(agent).extensions.find((e) => e.name === "leafcode-commit-guard")?.enabled, true);
    assert.equal(listExtensions(agent).extensions.find((e) => e.name === "settle-followup-claim")?.enabled, true);
  });

  it("lists required extensions as enabled even when stale disabled state remains", () => {
    const { agentDir: agent } = fixture();
    writeExtension(join(agent, "extensions"), "leafcode-commit-guard");
    writeExtensionsState({ disabled: { "leafcode-commit-guard": true } });
    const listed = listExtensions(agent);
    assert.equal(listed.extensions.find((e) => e.name === "leafcode-commit-guard")?.enabled, true);
    assert.equal(listed.extensions.find((e) => e.name === "leafcode-commit-guard")?.required, true);
  });

  it("prefers bundled repo extensions over same-name global copies", () => {
    const { agentDir: agent } = fixture();
    const bundledRoot = join(data, "repo-extensions");
    writeExtension(bundledRoot, "leafcode-goal-loop");
    // Stale copy under ~/.pi/agent/extensions must be shadowed.
    const staleCopy = join(agent, "extensions", "leafcode-goal-loop", "index.js");
    writeExtension(join(agent, "extensions"), "leafcode-goal-loop");
    writeExtension(join(agent, "extensions"), "other");

    const listed = listExtensions(agent, { bundledDir: bundledRoot });
    assert.equal(listed.extensions.find((e) => e.name === "leafcode-goal-loop")?.filePath, join(bundledRoot, "leafcode-goal-loop", "index.js"));
    assert.notEqual(listed.extensions.find((e) => e.name === "leafcode-goal-loop")?.filePath, staleCopy);
    expectNames(listed.extensions, ["leafcode-goal-loop", "one", "other"]);
  });

  it("hides the legacy MCP adapter when the bundled fork is present", () => {
    const { agentDir: agent } = fixture();
    const bundledRoot = join(data, "repo-extensions");
    writeExtension(bundledRoot, "leafcode-mcp-adapter");
    writeExtension(join(agent, "extensions"), "pi-mcp-adapter");

    const listed = listExtensions(agent, { bundledDir: bundledRoot });
    expectNames(listed.extensions, ["leafcode-mcp-adapter", "one"]);
  });

  it("discovers extensions from installed packages (settings.json packages)", () => {
    const { agentDir: agent } = fixture();
    // Simulate a `pi install`-style package clone with a pi.extensions manifest.
    const pkgDir = join(agent, "git", "github.com", "DietrichGebert", "ponytail");
    mkdirSync(join(pkgDir, "pi-extension"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["./pi-extension/index.js"] } }),
      "utf8",
    );
    writeFileSync(join(pkgDir, "pi-extension", "index.js"), "export default () => {};\n", "utf8");
    mkdirSync(join(agent, "git", "github.com", "DietrichGebert"), { recursive: true });
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({ packages: ["git:github.com/DietrichGebert/ponytail"] }),
      "utf8",
    );

    const listed = listExtensions(agent);
    assert.equal(listed.extensions.find((e) => e.name === "ponytail")?.filePath, join(pkgDir, "pi-extension", "index.js"));
    expectNames(listed.extensions, ["one", "ponytail"]);
  });

  it("discovers extensions from npm packages (settings.json packages)", () => {
    const { agentDir: agent } = fixture();
    const pkgDir = join(agent, "npm", "node_modules", "pi-mcp-adapter");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "utf8",
    );
    writeFileSync(join(pkgDir, "index.ts"), "export default () => {};\n", "utf8");
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }),
      "utf8",
    );

    const listed = listExtensions(agent);
    assert.equal(listed.extensions.find((e) => e.name === "pi-mcp-adapter")?.filePath, join(pkgDir, "index.ts"));
    expectNames(listed.extensions, ["one", "pi-mcp-adapter"]);
  });

  it("discovers extensions from local packages (settings.json packages)", () => {
    const { agentDir: agent } = fixture();
    const pkgDir = join(agent, "local-package");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
      "utf8",
    );
    writeFileSync(join(pkgDir, "index.ts"), "export default () => {};\n", "utf8");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["./local-package"] }), "utf8");

    const listed = listExtensions(agent);
    assert.equal(listed.extensions.find((e) => e.name === "local-package")?.filePath, join(pkgDir, "index.ts"));
    expectNames(listed.extensions, ["local-package", "one"]);
  });
});

describe("resolvePackageDir", () => {
  it("resolves git:github.com/owner/repo to ~/.pi/agent/git/...", () => {
    assert.equal(
      resolvePackageDir("git:github.com/DietrichGebert/ponytail", "C:\\pi\\agent"),
      "C:\\pi\\agent\\git\\github.com\\DietrichGebert\\ponytail",
    );
  });

  it("resolves https://github.com/owner/repo", () => {
    assert.equal(
      resolvePackageDir("https://github.com/DietrichGebert/ponytail", "C:\\pi\\agent"),
      "C:\\pi\\agent\\git\\github.com\\DietrichGebert\\ponytail",
    );
  });

  it("resolves npm:pkg to ~/.pi/agent/npm/node_modules", () => {
    assert.equal(
      resolvePackageDir("npm:pi-mcp-adapter", "C:\\pi\\agent"),
      "C:\\pi\\agent\\npm\\node_modules\\pi-mcp-adapter",
    );
  });

  it("strips npm version spec", () => {
    assert.equal(
      resolvePackageDir("npm:pi-mcp-adapter@2.0.0", "C:\\pi\\agent"),
      "C:\\pi\\agent\\npm\\node_modules\\pi-mcp-adapter",
    );
  });

  it("resolves scoped npm packages", () => {
    assert.equal(
      resolvePackageDir("npm:@scope/pkg@1.2.3", "C:\\pi\\agent"),
      "C:\\pi\\agent\\npm\\node_modules\\@scope\\pkg",
    );
  });

  it("resolves local package paths relative to the Pi agent directory", () => {
    assert.equal(
      resolvePackageDir("..\\..\\OneDrive\\AI\\Pi\\LeafCodePi\\extensions\\leafcode-todowrite", "C:\\Users\\Daichi\\.pi\\agent"),
      resolve("C:\\Users\\Daichi\\.pi\\agent", "..\\..\\OneDrive\\AI\\Pi\\LeafCodePi\\extensions\\leafcode-todowrite"),
    );
  });

  it("returns null for unsupported sources", () => {
    assert.equal(resolvePackageDir("ssh://git@github.com/user/repo", "C:\\pi\\agent"), null);
  });
});

describe("readPiSettings", () => {
  let agentDir = "";

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  it("reads packages from settings.json", () => {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-ext-settings-"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:github.com/a/b"] }), "utf8");
    assert.deepEqual(readPiSettings(agentDir), { packages: ["git:github.com/a/b"] });
  });
});

describe("extensionsStatePath", () => {
  it("lives in the leafcode-pi data dir", () => {
    assert.equal(extensionsStatePath("C:\\data"), "C:\\data\\extensions-state.json");
  });
});

function expectNames(extensions: { name: string }[], names: string[]) {
  assert.deepEqual(
    extensions.map((e) => e.name).sort(),
    [...names].sort(),
  );
}
