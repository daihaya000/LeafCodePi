import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, vi } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { compactSdkDocumentation } from "../agents-md";
import { basenameKey, filterExtensionsByState, listExtensions } from "../extensions";
import { shapeAnthropicOAuthSystemPrompt } from "../../../../extensions/pi-anthropic-auth/src/system-prompt-shaping";

const bundledRoot = fileURLToPath(new URL("../../../../extensions/", import.meta.url));
const entryPath = join(bundledRoot, "pi-anthropic-auth", "index.ts");
let agentDir = "";

afterEach(() => {
  vi.unstubAllEnvs();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = "";
});

const stockDocsSection = [
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
  "- Main documentation: C:\\x\\node_modules\\@earendil-works\\pi-coding-agent\\README.md",
  "- Additional docs: C:\\x\\node_modules\\@earendil-works\\pi-coding-agent\\docs",
  "- Examples: C:\\x\\node_modules\\@earendil-works\\pi-coding-agent\\examples (extensions, custom tools, SDK)",
  "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
  "- When asked about: extensions (docs/extensions.md), themes (docs/themes.md)",
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
].join("\n");

describe("bundled pi-anthropic-auth", () => {
  it("drops the compacted stock docs section from shaped anthropic requests", () => {
    const prompt = [
      "You are an expert coding assistant operating inside pi, a coding agent harness.",
      "",
      "<tools>",
      "- read: Read file contents",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
      "",
      "<docs>",
      stockDocsSection,
      "</docs>",
    ].join("\n");
    const compacted = compactSdkDocumentation(prompt);
    // The compaction must survive the extension's anchor check so shaping drops
    // the section instead of forwarding the SDK package path to Anthropic.
    assert.ok(compacted.includes("Pi documentation (read only when the user asks about pi itself"));
    const shaped = shapeAnthropicOAuthSystemPrompt(compacted);
    assert.ok(!shaped.includes("<docs>"));
    assert.ok(!shaped.includes("pi-coding-agent"));
    assert.ok(shaped.includes("- read: Read file contents"));
    assert.ok(!shaped.includes("In addition to the tools above"));
  });
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
