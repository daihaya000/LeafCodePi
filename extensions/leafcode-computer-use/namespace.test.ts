import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => process.env.LEAFCODE_CU_TEST_AGENT_DIR,
}));

import { loadComputerUseConfig } from "./src/config";
import { WINDOWS_HELPER_PATH, windowsHelper } from "./src/platform/windows/helper";

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
