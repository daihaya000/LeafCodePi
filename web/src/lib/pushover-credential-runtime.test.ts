import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readPushoverCredentials, savePushoverSettings } from "./pushover-config";

const directories: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("Pi credential runtime contract used by Pushover", () => {
  it("round-trips settings through the actual Pi auth path", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pushover-settings-"));
    directories.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    await savePushoverSettings({ token: "testToken123", user: "testUser123" });
    expect(await readPushoverCredentials()).toMatchObject({ token: "testToken123", user: "testUser123" });
  });

  it("persists and removes an API key for a model-free custom provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-pushover-auth-"));
    directories.push(root);
    const options = { authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false } as const;
    const runtime = await ModelRuntime.create(options);
    runtime.registerProvider("leafcode-pushover-token", {
      name: "Pushover Token", baseUrl: "https://api.pushover.net", models: [],
    });
    await runtime.login("leafcode-pushover-token", "api_key", {
      prompt: async () => "testToken123", notify: () => {},
    });
    const reopened = await ModelRuntime.create(options);
    reopened.registerProvider("leafcode-pushover-token", {
      name: "Pushover Token", baseUrl: "https://api.pushover.net", models: [],
    });
    expect((await reopened.getAuth("leafcode-pushover-token"))?.auth.apiKey).toBe("testToken123");
    await reopened.logout("leafcode-pushover-token");
    expect((await reopened.getAuth("leafcode-pushover-token"))?.auth.apiKey).toBeUndefined();
  });
});
