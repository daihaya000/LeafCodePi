import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { __resetCommandCodeProviderCacheForTests, registerCommandCodeProvider } from "./commandcode-provider";

const dirs: string[] = [];
const requests: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];

beforeEach(() => {
  __resetCommandCodeProviderCacheForTests();
  requests.length = 0;
  const dir = mkdtempSync(join(tmpdir(), "leafcode-commandcode-transport-"));
  dirs.push(dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("COMMANDCODE_MODELS_CACHE", join(dir, "models.json"));
  vi.stubEnv("COMMANDCODE_MODELS_URL", "https://commandcode.test/models");
  vi.stubEnv("COMMANDCODE_API_BASE", "https://commandcode.test/provider/v1");
  vi.stubEnv("COMMANDCODE_API_KEY", "unrelated-env-key");
  vi.stubEnv("COMMAND_CODE_API_KEY", "unrelated-alt-key");
});

afterEach(() => {
  __resetCommandCodeProviderCacheForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runtime() {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("commandcode", async () => ({ type: "api_key", key: "account-test-key" }));
  const rt = await ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  await registerCommandCodeProvider(rt, {
    key: "account:test", kind: "account", accountId: "test", accountLabel: "Test",
    authPath: join(dirs[dirs.length - 1], "auth.json"),
  });
  return rt;
}

function mockApi(goPlan = false) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return Response.json({ object: "list", data: [{
      id: "test-model", name: "Test Model", context_length: 32_000,
      supported_endpoints: ["/chat/completions"],
    }] });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/chat/completions")) {
      if (goPlan) return Response.json({ error: { code: "upgrade_required" } }, { status: 403 });
      return new Response([
        'data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
        'data: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]", "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }
    if (url === "https://commandcode.test/alpha/generate") {
      return new Response([
        { type: "text-delta", text: "OK" }, { type: "finish", finishReason: "stop" },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    }
    throw new Error(`Unexpected Command Code endpoint: ${url}`);
  }));
}

const context = {
  systemPrompt: "Follow the test system instruction.",
  messages: [{ role: "user" as const, content: "Say OK.", timestamp: 1 }],
  tools: [{ name: "test_tool", description: "A test tool", parameters: {
    type: "object" as const, properties: {}, required: [],
  } }],
};

describe("Command Code transport against the installed SDK", () => {
  it("uses the Provider API and the account key, preserving system instructions and tools", async () => {
    mockApi();
    const rt = await runtime();
    const model = rt.getModel("commandcode", "test-model")!;
    assert.ok(model);
    const result = await rt.completeSimple(model, context);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "OK" }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://commandcode.test/provider/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer account-test-key");
    const body = requests[0].body;
    assert.match(JSON.stringify(body.messages), /Follow the test system instruction/);
    assert.match(JSON.stringify(body.tools), /test_tool/);
  }, 15_000);

  it("preserves SDK transcript instructions and tools on the Go-plan generate fallback", async () => {
    mockApi(true);
    const rt = await runtime();
    const result = await rt.completeSimple(rt.getModel("commandcode", "test-model")!, context);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "OK" }]);
    assert.deepEqual(requests.map((request) => request.url), [
      "https://commandcode.test/provider/v1/chat/completions",
      "https://commandcode.test/alpha/generate",
    ]);
    const generate = requests[1];
    const params = generate.body.params as Record<string, unknown>;
    assert.equal(params.system, context.systemPrompt);
    assert.match(JSON.stringify(params.tools), /test_tool/);
    assert.match(JSON.stringify(params.messages), /Say OK/);
    assert.equal(generate.authorization, "Bearer account-test-key");
  }, 15_000);
});
