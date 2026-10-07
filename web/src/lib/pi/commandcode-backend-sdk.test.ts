import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "vitest";

it("registers and selects Command Code in a Backend bundle without a global provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "commandcode-backend-sdk-"));
  try {
    const repo = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
    mkdirSync(join(root, "web"));
    symlinkSync(join(repo, "web", "node_modules"), join(root, "web", "node_modules"), "junction");
    const bundle = join(root, "backend", "runtime", "provider.bundle.mjs");
    const require = createRequire(import.meta.url);
    const esbuild = require("esbuild") as typeof import("esbuild");
    await esbuild.build({
      entryPoints: [join(repo, "web", "src", "lib", "pi", "commandcode-provider.ts")],
      outfile: bundle, bundle: true, format: "esm", platform: "node", target: "node22",
      external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "node:*"],
      banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
      logLevel: "silent",
    });
    const sdk = pathToFileURL(join(repo, "backend", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;
    const ai = pathToFileURL(join(repo, "backend", "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href;
    const script = join(root, "probe.mjs");
    writeFileSync(script, `
      import assert from 'node:assert/strict';
      import { InMemoryCredentialStore, InMemoryModelsStore } from ${JSON.stringify(ai)};
      import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from ${JSON.stringify(sdk)};
      import { registerCommandCodeProvider, resolveCommandCodeExtensionEntry } from ${JSON.stringify(pathToFileURL(bundle).href)};
      globalThis.fetch = async () => Response.json({ object: 'list', data: [
        { id: 'backend-test', name: 'Backend Test', context_length: 32000, supported_endpoints: ['/chat/completions'] }
      ] });
      const credentials = new InMemoryCredentialStore();
      await credentials.modify('commandcode', async () => ({ type: 'api_key', key: 'backend-account-test-key' }));
      const rt = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
      await registerCommandCodeProvider(rt, { key: 'account:test', kind: 'account', authPath: ${JSON.stringify(join(root, "auth.json"))} });
      const model = rt.getModel('commandcode', 'backend-test');
      assert.ok(model, 'Backend must find and register the repository provider');
      assert.equal((await rt.getAuth(model)).auth.apiKey, 'backend-account-test-key');
      assert.equal((await rt.getAvailable('commandcode')).some(x => x.id === model.id), true);
      rt.registerProvider('initial', { apiKey: 'initial-test-key', baseUrl: 'https://initial.test/v1', models: [{
        id: 'initial-model', name: 'Initial Model', api: 'openai-completions', reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 64
      }] });
      const settingsManager = SettingsManager.inMemory({ packages: [] });
      const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await resourceLoader.reload();
      const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.cwd(),
        modelRuntime: rt, model: rt.getModel('initial', 'initial-model'), settingsManager, resourceLoader,
        sessionManager: SessionManager.inMemory(process.cwd()), tools: [] });
      try {
        await session.setModel(model);
        assert.equal(session.model.provider, 'commandcode');
        assert.equal(session.model.id, 'backend-test');
        console.log(JSON.stringify({ provider: session.model.provider, model: session.model.id,
          available: true, entry: resolveCommandCodeExtensionEntry() }));
      } finally { session.dispose(); }
    `, "utf8");
    const child = spawnSync(process.execPath, [script], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: root,
        COMMANDCODE_MODELS_URL: "https://commandcode.test/models",
        COMMANDCODE_MODELS_CACHE: join(root, "models.json"),
        COMMANDCODE_API_KEY: "", COMMAND_CODE_API_KEY: "" },
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const answer = JSON.parse(child.stdout.trim());
    assert.equal(answer.provider, "commandcode");
    assert.equal(answer.model, "backend-test");
    assert.equal(answer.available, true);
    assert.equal(answer.entry, join(root, "web", "node_modules", "pi-commandcode-provider", "index.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
