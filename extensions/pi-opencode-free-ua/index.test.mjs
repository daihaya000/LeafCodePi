import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import test from "node:test";
import extension, { freeTierModel, freeTierProvider, openCodeHeaders, resolveOpenCodeProviderPath } from "./index.ts";

const { opencodeProvider } = await import(pathToFileURL(resolveOpenCodeProviderPath()).href);

test("replaces Pi's built-in attribution, not caller-owned client identities", () => {
  assert.equal(openCodeHeaders({ "x-opencode-client": "pi" }, "session-a")["x-opencode-client"], "opencode");
  assert.equal(openCodeHeaders({ "x-opencode-client": "custom" })["x-opencode-client"], "custom");
});

test("normalizes mixed-case duplicates and fills missing/null/empty headers without mutation", () => {
  for (const empty of [undefined, null, "", "  "]) {
    const input = { "X-OpenCode-Client": empty, "X-OpenCode-Session": empty, authorization: "test-only" };
    const copy = { ...input };
    assert.deepEqual(openCodeHeaders(input, "session-a"), {
      authorization: "test-only", "x-opencode-client": "opencode", "x-opencode-session": "session-a",
    });
    assert.deepEqual(input, copy);
  }
  assert.deepEqual(openCodeHeaders({ "X-OpenCode-Client": "pi", "x-opencode-client": null,
    "X-OpenCode-Session": "existing", "x-opencode-session": "" }, "ignored"), {
    "x-opencode-client": "opencode", "x-opencode-session": "existing",
  });
});

test("standalone calls get independent session IDs; an explicit session is retained", () => {
  const first = openCodeHeaders();
  const second = openCodeHeaders();
  assert.match(first["x-opencode-session"], /^[0-9a-f-]{36}$/);
  assert.notEqual(first["x-opencode-session"], second["x-opencode-session"]);
  assert.equal(openCodeHeaders({ "x-opencode-session": "explicit" }, "other")["x-opencode-session"], "explicit");
});

test("projects current and future free Responses models, preserving metadata and original catalog", () => {
  const original = opencodeProvider().getModels().find((model) => model.id === "muse-spark-1.3-contributor-free");
  assert.ok(original);
  for (const id of [original.id, "muse-spark-1.4-contributor-free", "future-free"]) {
    const model = { ...original, id };
    const projected = freeTierModel(model);
    assert.equal(projected.api, "openai-completions");
    assert.equal(model.api, "openai-responses");
    assert.equal(projected.contextWindow, model.contextWindow);
    assert.equal(projected.thinkingLevelMap, model.thinkingLevelMap);
    assert.equal(projected.inputLimits, model.inputLimits);
    assert.deepEqual(projected.compat, {
      supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens",
    });
  }
  for (const model of opencodeProvider().getAllModels().filter((model) =>
    model.api !== "openai-responses" || !model.id.endsWith("-free"))) {
    assert.equal(freeTierModel(model), model);
  }
  assert.equal(freeTierModel({ ...original, provider: "other" }).api, "openai-responses");
});

test("registers the full native provider, without depending on cwd or dropping classifiers/auth", async () => {
  let registered;
  await extension({ on() {}, registerProvider: (provider) => { registered = provider; } });
  const base = opencodeProvider();
  assert.equal(registered.id, "opencode");
  assert.equal(registered.getAllModels().length, base.getAllModels().length);
  assert.ok(registered.classify);
  assert.ok(registered.auth.apiKey);
  assert.equal(registered.getModels().find((model) => model.id.endsWith("contributor-free")).api, "openai-completions");
  const cwd = process.cwd();
  try {
    process.chdir(process.env.TEMP || "/tmp");
    assert.ok(resolveOpenCodeProviderPath().endsWith("opencode.js"));
  } finally { process.chdir(cwd); }
});

test("explains only free-tier client denials without changing other provider failures or retry semantics", async () => {
  let handler;
  await extension({ registerProvider() {}, on(event, callback) {
    assert.equal(event, "message_end"); handler = callback;
  } });
  const message = { role: "assistant", provider: "opencode", model: "muse-spark-1.3-contributor-free",
    stopReason: "error", errorMessage: '403 {"error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}', content: [] };
  const result = handler({ message });
  assert.ok(result.message.errorMessage.startsWith(message.errorMessage));
  assert.ok(result.message.errorMessage.includes("[pi-opencode-free-ua]"));
  assert.equal(result.message.stopReason, "error");
  assert.equal(handler({ message: result.message }), undefined);
  assert.ok(!message.errorMessage.includes("[pi-opencode-free-ua]"));
  for (const override of [{ provider: "other" }, { model: "paid-model" }, { role: "user" },
    { stopReason: "aborted" }, { errorMessage: "429 RateLimitError" }, { errorMessage: "401 AuthError" },
    { errorMessage: "403 RegionError" }, { errorMessage: "context_length_exceeded" }]) {
    assert.equal(handler({ message: { ...message, ...override } }), undefined);
  }
});

test("all chat dispatch paths use the request model, preserve hooks/options and isolate headers", () => {
  const original = opencodeProvider();
  const calls = [];
  const marker = {};
  const base = { ...original,
    stream: (...args) => { calls.push(args); return marker; },
    streamSimple: (...args) => { calls.push(args); return marker; },
    classify: (...args) => { calls.push(args); return marker; },
  };
  const provider = freeTierProvider(base);
  assert.equal(provider.auth, original.auth);
  const model = original.getModels().find((model) => model.id.endsWith("contributor-free"));
  const context = { messages: [] };
  const options = { sessionId: "session", headers: { "X-OpenCode-Client": "pi" },
    signal: new AbortController().signal, onPayload() {}, onResponse() {}, onProviderStreamEvent() {}, maxRetries: 0 };
  for (const method of ["stream", "streamSimple"]) {
    assert.equal(provider[method](model, context, options), marker);
    const [sentModel, sentContext, sentOptions] = calls.at(-1);
    assert.equal(sentModel.api, "openai-completions");
    assert.equal(sentContext, context);
    assert.deepEqual(sentOptions, { ...options, headers: {
      "x-opencode-client": "opencode", "x-opencode-session": "session",
    } });
  }
  assert.deepEqual(options.headers, { "X-OpenCode-Client": "pi" });
  assert.equal(provider.classify(original.getAllModels().find((model) => model.type === "classifier"), {}, options), marker);
  assert.equal(calls.at(-1)[2].headers["x-opencode-client"], "opencode");
  assert.ok(calls.at(-1)[2].headers["x-opencode-session"]);
});

test("native SDK sends real HTTP with correct endpoint, client/session headers and completions payload", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = freeTierProvider(opencodeProvider());
    const model = { ...provider.getModels().find((model) => model.id.endsWith("contributor-free")),
      baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
    for (const headers of [{ "x-opencode-client": "pi" }, { "X-OpenCode-Session": "explicit" }]) {
      const result = await provider.streamSimple(model, { messages: [{ role: "user", content: "OK", timestamp: 0 }] }, {
        apiKey: "test-only", headers, maxTokens: 16, maxRetries: 0, reasoning: "minimal",
      }).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(result.content[0].text, "OK");
    }
    for (const request of requests) {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers["x-opencode-client"], "opencode");
      assert.ok(request.headers["x-opencode-session"]);
      assert.equal(request.body.max_tokens, 16);
      assert.equal(request.body.store, undefined);
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[1].headers["x-opencode-session"], "explicit");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
