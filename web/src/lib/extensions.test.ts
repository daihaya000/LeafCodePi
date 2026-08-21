import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  basenameKey,
  extensionsStatePath,
  filterExtensionsByState,
  isExtensionDisabled,
  listExtensions,
  readExtensionsState,
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
});

describe("listExtensions / setExtensionEnabled", () => {
  let agentDir = "";
  let data = "";
  let prevData: string | undefined;

  afterEach(() => {
    if (prevData === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = prevData;
    prevData = undefined;
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

  function fixture() {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-ext-agent-"));
    data = mkdtempSync(join(tmpdir(), "leafcode-pi-ext-data-"));
    prevData = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = data;
    writeExtension(join(agentDir, "extensions"), "ponytail");
    writeFileSync(join(agentDir, "extensions", "one.js"), "export default () => {};\n", "utf8");
    writeExtensionsState({ disabled: {} });
    return { agentDir };
  }

  it("lists discovered extensions as enabled by default", () => {
    const { agentDir: agent } = fixture();
    const listed = listExtensions(agent);
    expectNames(listed.extensions, ["one", "ponytail"]);
    assert.equal(listed.extensions.every((e) => e.enabled), true);
    assert.equal(listed.extensionsDir, join(agent, "extensions"));
  });

  it("toggles extensions via extensions-state.json", () => {
    const { agentDir: agent } = fixture();
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
