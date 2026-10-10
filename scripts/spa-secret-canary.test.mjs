import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { assertNoCanary, auditCanaryResponses, canaryProbePlugin, createSecretCanaries, scanCanaryArtifacts, withCanaryEnvironment } from "./spa-secret-canary.mjs";

test("canaries cover process env and all four production dotenv layers with unique dummy values", () => {
  const canaries = createSecretCanaries();
  assert.equal(canaries.entries.length, 17);
  assert.equal(new Set(canaries.entries.map(entry => entry.value)).size, 17);
  assert.deepEqual(Object.keys(canaries.files), [".env", ".env.local", ".env.production", ".env.production.local"]);
  assert.equal(canaries.entries.filter(entry => entry.name === "VITE_DOTENV_PRECEDENCE_TOKEN").length, 4);
  assert.ok(canaries.entries.every(entry => entry.value.startsWith("lcp_dummy_secret_")));
});

for (const [encoding, encode] of Object.entries({ raw: value => value, base64: value => Buffer.from(value).toString("base64"), base64url: value => Buffer.from(value).toString("base64url"), hex: value => Buffer.from(value).toString("hex"), unicode: value => [...Buffer.from(value)].map(byte => `\\u${byte.toString(16).padStart(4, "0")}`).join(""), javascript: value => [...Buffer.from(value)].map(byte => `\\x${byte.toString(16).padStart(2, "0")}`).join("") })) {
  test(`scanner detects ${encoding} disclosure without echoing its value`, () => {
    const { entries } = createSecretCanaries(), entry = entries[0];
    let reason;
    try { assertNoCanary(`prefix ${encode(entry.value)} suffix`, entries, "fixture sink"); } catch (error) { reason = error; }
    assert.ok(reason);
    assert.match(reason.message, /VITE_SECRET.*process.env.*fixture sink/);
    assert.equal(reason.message.includes(entry.value), false);
    assert.equal(reason.message.includes(encode(entry.value)), false);
  });
}

test("artifact audit recursively inspects HTML, lazy JS, maps and binary assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-spa-canary-unit-"));
  const { entries } = createSecretCanaries();
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<html>safe</html>");
    await writeFile(join(root, "assets", "lazy.js"), "console.log('safe')");
    const safe = await scanCanaryArtifacts(root, entries);
    assert.equal(safe.files.length, 2); assert.equal(safe.maps, 0);
    for (const [filename, content] of [["index.html", entries[0].value], ["assets/lazy.js", entries[0].value], ["assets/source.js.map", JSON.stringify({ sourcesContent: [entries[0].value] })], ["assets/image.png", Buffer.concat([Buffer.from([0, 255]), Buffer.from(entries[0].value)])]]) {
      await writeFile(join(root, filename), content);
      await assert.rejects(scanCanaryArtifacts(root, entries), /SPA secret canary leaked/);
      await writeFile(join(root, filename), "safe");
    }
    assert.equal((await scanCanaryArtifacts(root, entries)).maps, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact filenames are also disclosure sinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-spa-canary-name-"));
  const { entries } = createSecretCanaries();
  try {
    await writeFile(join(root, "index.html"), "safe");
    await writeFile(join(root, entries[0].value + ".js"), "safe");
    await assert.rejects(scanCanaryArtifacts(root, entries), /into artifact filename/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an empty or partial artifact directory cannot yield a false pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-spa-canary-empty-"));
  try {
    await assert.rejects(scanCanaryArtifacts(root, []), /entry HTML/);
    await writeFile(join(root, "index.html"), "safe");
    await assert.rejects(scanCanaryArtifacts(root, []), /browser bundle/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isolated build env excludes inherited credentials and restores it on success/failure", async () => {
  const prior = process.env.LEAFCODE_CANARY_RESTORE_SENTINEL;
  process.env.LEAFCODE_CANARY_RESTORE_SENTINEL = "dummy inherited value";
  try {
    for (const fail of [false, true]) {
      const action = withCanaryEnvironment(createSecretCanaries(), async () => {
        assert.equal(process.env.LEAFCODE_CANARY_RESTORE_SENTINEL, undefined);
        assert.equal(process.env.NODE_ENV, "production");
        assert.match(process.env.OPENAI_API_KEY, /^lcp_dummy_secret_/);
        process.env.LEAFCODE_CANARY_EXTRA = "dummy mutation";
        if (fail) throw Error("fixture failure");
        return "ok";
      });
      if (fail) await assert.rejects(action, /fixture failure/); else assert.equal(await action, "ok");
      assert.equal(process.env.LEAFCODE_CANARY_RESTORE_SENTINEL, "dummy inherited value");
      assert.equal(process.env.LEAFCODE_CANARY_EXTRA, undefined);
    }
  } finally {
    if (prior === undefined) delete process.env.LEAFCODE_CANARY_RESTORE_SENTINEL; else process.env.LEAFCODE_CANARY_RESTORE_SENTINEL = prior;
  }
});

test("response audit never waits for an unfinished or reload-cancelled response body", async () => {
  const context = new EventEmitter(), errors = [];
  let bodyCalls = 0;
  const response = { headers: () => ({ "content-type": "text/html" }), body: () => { bodyCalls++; return new Promise(() => {}); } };
  const flush = auditCanaryResponses(context, createSecretCanaries().entries, error => errors.push(error));
  context.emit("response", response);
  context.emit("requestfailed", { response: async () => response });
  assert.equal(await flush(), 0); assert.equal(bodyCalls, 0); assert.deepEqual(errors, []);
});

test("response audit checks finished bodies and headers and reports disclosure", async () => {
  const context = new EventEmitter(), errors = [], { entries } = createSecretCanaries();
  const flush = auditCanaryResponses(context, entries, error => errors.push(error));
  const response = (headers, body) => ({ headers: () => headers, body: async () => Buffer.from(body) });
  const request = result => ({ url: () => "http://fixture/index.html", resourceType: () => "document", response: async () => result });
  context.emit("response", response({ "x-private": entries[0].value }, "safe"));
  context.emit("requestfinished", request(response({}, "safe")));
  context.emit("requestfinished", request(response({}, entries[0].value)));
  assert.equal(await flush(), 1); assert.equal(errors.length, 2);
  assert.match(errors[0], /response headers/); assert.match(errors[1], /response body/);
  assert.ok(errors.every(error => !error.includes(entries[0].value)));
});

test("SSE bodies are not buffered, including fetch-based streams", async () => {
  const context = new EventEmitter(), errors = [];
  let bodyCalls = 0;
  const flush = auditCanaryResponses(context, createSecretCanaries().entries, error => errors.push(error));
  for (const [path, type, mime] of [["/api/bots/events", "fetch", "text/plain"], ["/any", "eventsource", "text/plain"], ["/fetch-stream", "fetch", "text/event-stream"]]) {
    context.emit("requestfinished", { url: () => `http://fixture${path}`, resourceType: () => type, response: async () => ({ headers: () => ({ "content-type": mime }), body: () => { bodyCalls++; return new Promise(() => {}); } }) });
  }
  assert.equal(await flush(), 0); assert.equal(bodyCalls, 0); assert.deepEqual(errors, []);
});

test("a completed response that cannot be read fails the audit rather than passing silently", async () => {
  const context = new EventEmitter(), errors = [];
  const flush = auditCanaryResponses(context, createSecretCanaries().entries, error => errors.push(error));
  context.emit("requestfinished", { url: () => "http://fixture/api/settings", resourceType: () => "fetch", response: async () => ({ headers: () => ({}), body: async () => { throw Error("fixture unreadable body"); } }) });
  assert.equal(await flush(), 0); assert.match(errors[0], /fixture unreadable body/);
});

test("env probe is injected only into the SPA entry and contains names, not values", () => {
  const { entries } = createSecretCanaries(), plugin = canaryProbePlugin(entries);
  const id = plugin.resolveId("leafcode-spa-canary-probe");
  const code = plugin.load(id);
  assert.match(code, /env: import.meta.env/);
  assert.match(code, /import.meta.env.VITE_SECRET/);
  assert.match(code, /process.env.LEAFCODE_PI_WEBUI_TOKEN/);
  assertNoCanary(code, entries, "probe source");
  assert.equal(plugin.load("other"), undefined);
  assert.equal(plugin.transform("source", "C:/web/src/spa/navigation.tsx"), undefined);
  assert.match(plugin.transform("source", "C:\\web\\src\\spa\\main.tsx"), /import 'leafcode-spa-canary-probe'/);
});
