import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAskTimeoutMs, getConfigPath, loadConfig, loadInboundTriggerPolicy } from "./config.ts";

test("public and supervisor ask defaults preserve explicit environment overrides", () => {
  const previous = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  try {
    delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    assert.equal(getAskTimeoutMs(60_000), 60_000);
    assert.equal(getAskTimeoutMs(), 600_000);
    process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "120000";
    assert.equal(getAskTimeoutMs(60_000), 120_000);
    process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "2147483648";
    assert.throws(() => getAskTimeoutMs(), /no greater than/);
  } finally {
    if (previous === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previous;
  }
});

async function withAgentDir<T>(agentDir: string, fn: () => T | Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("getConfigPath uses the centralized intercom runtime directory", () => {
  assert.equal(getConfigPath("/tmp/pi-agent/intercom"), join("/tmp/pi-agent", "intercom", "config.json"));
});

test("loadConfig reads config below PI_CODING_AGENT_DIR", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));

  try {
    const intercomDir = join(root, "intercom");
    mkdirSync(intercomDir, { recursive: true });
    writeFileSync(join(intercomDir, "config.json"), JSON.stringify({ status: "platform-test" }));

    await withAgentDir(root, () => {
      assert.equal(loadConfig().status, "platform-test");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig defaults inboundTrigger to ask/reply auto-trigger behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      assert.equal(loadConfig().inboundTrigger, "replies");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts inboundTrigger always policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "always" }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().inboundTrigger, "always");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig ignores obsolete toolVisibility values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ toolVisibility: "lazy", replyHint: false }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().replyHint, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts a restart-stable intercom id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ stableId: " pinned-worker " }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().stableId, "pinned-worker");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadInboundTriggerPolicy re-reads the current policy on every call", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      assert.equal(loadInboundTriggerPolicy(), "replies");
      mkdirSync(join(root, "intercom"), { recursive: true });
      const configPath = join(root, "intercom", "config.json");
      writeFileSync(configPath, JSON.stringify({ inboundTrigger: "never" }));
      assert.equal(loadInboundTriggerPolicy(), "never");
      writeFileSync(configPath, JSON.stringify({ inboundTrigger: "always" }));
      assert.equal(loadInboundTriggerPolicy(), "always");
      // Session-fixed keys are validated at session start, not by the live policy read.
      writeFileSync(configPath, JSON.stringify({ brokerArgs: "invalid" }));
      assert.equal(loadInboundTriggerPolicy(), "replies");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadInboundTriggerPolicy rejects malformed or invalid policy config", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    const configPath = join(root, "intercom", "config.json");
    await withAgentDir(root, () => {
      writeFileSync(configPath, "{ broken");
      assert.throws(() => loadInboundTriggerPolicy(), /Failed to load intercom config/);
      writeFileSync(configPath, JSON.stringify({ inboundTrigger: "prompt" }));
      assert.throws(
        () => loadInboundTriggerPolicy(),
        /Failed to load intercom config.*"inboundTrigger" must be "always", "replies", or "never"/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid inboundTrigger values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "prompt" }));

    await withAgentDir(root, () => {
      assert.throws(
        () => loadConfig(),
        /Failed to load intercom config.*"inboundTrigger" must be "always", "replies", or "never"/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
