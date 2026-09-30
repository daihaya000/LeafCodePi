import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, vi } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { basenameKey, filterExtensionsByState, listExtensions } from "../extensions";

const bundledRoot = fileURLToPath(new URL("../../../../extensions/", import.meta.url));
const entryPath = join(bundledRoot, "pi-anthropic-auth", "index.ts");
let agentDir = "";

afterEach(() => {
  vi.unstubAllEnvs();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = "";
});

describe("bundled pi-anthropic-auth", () => {
  it.each([false, true])("loads exactly one bundled copy without credentials (local CLI registration: %s)", async (registeredForCli) => {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-anthropic-auth-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(agentDir, "data"));
    const listed = listExtensions(agentDir, { bundledDir: bundledRoot });
    const auth = listed.extensions.find((extension) => extension.name === "pi-anthropic-auth");
    assert.ok(auth);
    assert.equal(auth.filePath, entryPath);
    assert.equal(auth.source, "bundled");
    assert.equal(auth.required, false);
    assert.equal(auth.enabled, true);

    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.inMemory({
        packages: registeredForCli ? [join(bundledRoot, "pi-anthropic-auth")] : [],
      }),
      additionalExtensionPaths: [auth.filePath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.equal(basenameKey(loaded.extensions[0].path), "pi-anthropic-auth");
    assert.ok(loaded.extensions[0].commands.has("anthropic-auth:status"));
    const providers = loaded.runtime.pendingProviderRegistrations;
    assert.equal(providers.length, 1);
    assert.equal(providers[0].name, "anthropic");
    assert.equal(providers[0].config.api, "anthropic-messages");
    assert.equal(typeof providers[0].config.streamSimple, "function");
    // Login, credentials, model catalog and endpoints remain owned by Pi.
    assert.equal(providers[0].config.oauth, undefined);
    assert.equal(providers[0].config.models, undefined);
    assert.equal(providers[0].config.baseUrl, undefined);
    assert.deepEqual(
      filterExtensionsByState(loaded.extensions, { disabled: { "pi-anthropic-auth": true } }, agentDir),
      [],
    );
  });
});
