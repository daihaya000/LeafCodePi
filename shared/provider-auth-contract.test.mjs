import test from "node:test";
import assert from "node:assert/strict";
import { providerAuthTarget, publicProviderLoginEvent, publicProviderAuthBody } from "./provider-auth-contract.mjs";
test("auth routing decodes once and excludes the separate read-only SSE transport", () => {
  assert.deepEqual(providerAuthTarget("providers/a%252Fb/login/answer"), { route: "providers/[id]/login/answer", params: { id: "a%2Fb" } });
  assert.equal(providerAuthTarget("providers/p/login/events"), null); assert.equal(providerAuthTarget("providers/%xx/login"), null);
});
test("auth event projection retains the UI protocol and never includes inputs or raw SDK errors", () => {
  const prompt = publicProviderLoginEvent({ type: "prompt", id: "p", prompt: { type: "secret", message: "Key", value: "PRIVATE" }, credentials: "PRIVATE" });
  assert.deepEqual(prompt, { type: "prompt", id: "p", prompt: { type: "secret", message: "Key" } });
  assert.deepEqual(publicProviderLoginEvent({ type: "done", ok: false, error: "PRIVATE" }), { type: "done", ok: false, error: "ログインに失敗しました" });
  assert.equal(publicProviderLoginEvent({ type: "done", ok: true, warning: "PRIVATE" }).warning, "認証は保存されましたが、モデル一覧の同期に失敗しました");
  assert.equal(publicProviderLoginEvent({ type: "notify", event: { type: "auth_url", url: "https://fixture.test/auth", callbackUrl: "http://localhost:1/callback", token: "PRIVATE" } }).event.token, undefined);
});
test("auth ACK is request execution, not an invented credential save or full login success", () => {
  const body = publicProviderAuthBody("providers/[id]/login", { sessionId: "s", apiKey: "PRIVATE", operation: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", execution: "complete", value: "PRIVATE" } }, 200);
  assert.deepEqual(body, { sessionId: "s", operation: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", execution: "complete" } });
  assert.equal(body.mutation, undefined);
});
