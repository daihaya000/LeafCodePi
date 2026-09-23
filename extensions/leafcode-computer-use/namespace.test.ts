import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => process.env.LEAFCODE_CU_TEST_AGENT_DIR,
}));

import { loadComputerUseConfig } from "./src/config";
import { WINDOWS_HELPER_PATH, windowsHelper } from "./src/platform/windows/helper";
import { LINUX_HELPER_PATH } from "./src/platform/linux/helper";

const previous = {
  agentDir: process.env.LEAFCODE_CU_TEST_AGENT_DIR,
  browserUse: process.env.PI_COMPUTER_USE_BROWSER_USE,
  headless: process.env.LEAFCODE_COMPUTER_USE_HEADLESS,
  forkBrowserUse: process.env.LEAFCODE_COMPUTER_USE_BROWSER_USE,
};
afterEach(() => {
  for (const [key, value] of Object.entries({
    LEAFCODE_CU_TEST_AGENT_DIR: previous.agentDir,
    PI_COMPUTER_USE_BROWSER_USE: previous.browserUse,
    LEAFCODE_COMPUTER_USE_HEADLESS: previous.headless,
    LEAFCODE_COMPUTER_USE_BROWSER_USE: previous.forkBrowserUse,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("uses isolated configuration and refuses browsers even when old settings enable them", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "leafcode-cu-config-"));
  try {
    const configDir = path.join(agentDir, "extensions");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "pi-computer-use.json"), JSON.stringify({ browser_use: true, headless: false }));
    writeFileSync(path.join(configDir, "leafcode-computer-use.json"), JSON.stringify({ browser_use: true }));
    process.env.LEAFCODE_CU_TEST_AGENT_DIR = agentDir;
    process.env.PI_COMPUTER_USE_BROWSER_USE = "1";
    process.env.LEAFCODE_COMPUTER_USE_HEADLESS = "1";
    process.env.LEAFCODE_COMPUTER_USE_BROWSER_USE = "1";
    const loaded = loadComputerUseConfig(agentDir);
    assert.equal(loaded.config.browser_use, false);
    assert.equal(loaded.config.headless, true);
    assert.equal(loaded.sources.length, 1);
    assert.equal(path.basename(loaded.sources[0].path), "leafcode-computer-use.json");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

it("reads the vendored Windows helper without installing it into the user profile", async () => {
  if (!process.env.LEAFCODE_COMPUTER_USE_WINDOWS_HELPER_PATH) {
    assert.equal(WINDOWS_HELPER_PATH, fileURLToPath(new URL("./prebuilt/windows/windows-bridge.exe", import.meta.url)));
    await windowsHelper.ensureInstalled();
  }
  assert.ok(existsSync(fileURLToPath(new URL("./scripts/setup-helper.mjs", import.meta.url))));
});

it("uses the pinned vendored Linux helpers without installing them", () => {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (!process.env.LEAFCODE_COMPUTER_USE_LINUX_HELPER_PATH) {
    assert.equal(LINUX_HELPER_PATH, fileURLToPath(new URL(`./prebuilt/linux/${arch}/linux-bridge`, import.meta.url)));
  }
  const pinned = {
    x64: "671658D3DD237B5DC86BBA0786A3CF48A9173EC24B9AA6775CB597B61B335EB9",
    arm64: "42E11B2E77FA3F9EC4B858C99CBC28703D086ACC84C2BD19DF2FB3DBCEEAB759",
  };
  for (const [name, hash] of Object.entries(pinned)) {
    const file = fileURLToPath(new URL(`./prebuilt/linux/${name}/linux-bridge`, import.meta.url));
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase(), hash);
  }
});
