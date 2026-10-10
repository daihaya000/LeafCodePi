import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

async function eventually(predicate, label) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
  assert.fail(label);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

/** Native browser UI + EventSource; owner/provider data is exclusively a dummy fixture. */
export async function runOAuthContracts({ pageFor, ready, checked, fixture, spaOrigin, nextOrigin }) {
  const evidence = [];
  const run = async (origin, size, viewport) => {
    fixture.oauth.enable();
    const start = fixture.log.length;
    const { page, context, flushResponses } = await pageFor(origin, viewport);
    const popups = [], popupRecords = [], steps = [], releases = [];
    context.on("page", popup => popups.push(popup));
    await context.route(/\/fixture-(oauth|device)(?:\?|$)/, route => route.fulfill({ contentType: "text/html", body: "<h1>Fixture authorization only</h1>" }));
    const card = label => page.getByText(label, { exact: true }).locator("xpath=ancestor::li[1]");
    const region = name => page.getByRole("region", { name: `${name} のログイン`, exact: true });
    const record = async (name, panel) => steps.push({ name, ...(await panel.evaluate(element => ({
      label: element.getAttribute("aria-label"), status: element.querySelector(":scope > p")?.textContent,
      inputs: [...element.querySelectorAll("input")].map(input => ({ label: element.querySelector(`label[for="${input.id}"]`)?.textContent, value: input.value, type: input.type, placeholder: input.placeholder, autocomplete: input.autocomplete, disabled: input.disabled })),
      errors: [...element.querySelectorAll('[role="alert"]')].map(node => node.textContent),
      device: element.textContent.includes("FIXT-ABCD"),
    }))) });
    const latestSession = () => [...fixture.oauth.sessions.values()].at(-1);
    const begin = async (label, provider) => {
      const count = fixture.oauth.sessions.size;
      await card(label).getByRole("button", { name: "再ログイン", exact: true }).click();
      await eventually(() => fixture.oauth.sessions.size > count, "Login POST must create a new fixture session");
      const session = latestSession();
      const panel = region(provider); await panel.waitFor();
      assert.equal(await card(label).getByRole("region", { name: `${provider} のログイン`, exact: true }).count(), 1);
      return { session, panel };
    };
    const popup = async (count, path) => {
      await eventually(() => popups.length === count, "Exactly one native OAuth popup must open");
      const child = popups[count - 1]; await child.waitForLoadState("load");
      assert.equal(new URL(child.url()).pathname, path);
      assert.equal(await child.evaluate(() => window.opener === null), true);
      popupRecords.push({ path, opener: null });
      await flushResponses(); await child.close();
    };
    const cancel = async (panel, session) => {
      await panel.getByRole("button", { name: "キャンセル", exact: true }).click();
      await panel.waitFor({ state: "detached" });
      await eventually(() => session.cancelled, "Cancellation must target the current server session");
    };
    const oneLoginStream = async session => {
      await eventually(() => fixture.oauth.activeStreams(session.id) === 1, "One login stream per active session");
      assert.equal(await page.evaluate(() => window.__sources.filter(source => source.url.includes("/login/events") && !source.closed).length), 1);
    };
    try {
      await page.goto(origin + "/settings#models-providers"); await ready(page, "/settings");
      await card("Fixture Codex A").waitFor(); await card("Fixture Codex B").waitFor(); await card("Fixture Claude A").waitFor();
      // Account-bound Codex method selection + loopback relay, invalid input retry,
      // and terminal SSE arriving before the callback HTTP response.
      let { session, panel } = await begin("Fixture Codex A", "OpenAI Codex");
      await panel.getByRole("button", { name: "Fixture browser login", exact: true }).click();
      await popup(1, "/fixture-oauth");
      const relay = panel.getByRole("textbox", { name: "ログイン後の戻り先URL全体", exact: true }); await relay.waitFor();
      await oneLoginStream(session);
      fixture.oauth.replayNotifications(session.id); await delay(300); assert.equal(popups.length, 1);
      await relay.fill("fixture-invalid-callback"); await panel.getByRole("button", { name: "送信", exact: true }).click();
      await panel.getByRole("alert").filter({ hasText: "Fixture callback URL/state mismatch" }).waitFor();
      assert.equal(await relay.inputValue(), "fixture-invalid-callback");
      assert.equal(await panel.getByRole("button", { name: "送信", exact: true }).isEnabled(), true);
      await record("codex-invalid-retryable", panel);
      const received = deferred(), release = deferred(); releases.push(release);
      const callbackRoute = /\/api\/providers\/openai-codex\/login\/callback$/;
      const holdCallback = async route => { const response = await route.fetch(); received.resolve(); await release.promise; await route.fulfill({ response }); };
      await context.route(callbackRoute, holdCallback);
      const input = `http://127.0.0.1:1456/auth/callback?code=fixture-code&state=${session.state}`;
      await relay.fill(input); await panel.getByRole("button", { name: "送信", exact: true }).click(); await received.promise;
      assert.equal(session.callback, input);
      fixture.oauth.done(session.id, { ok: true }); await panel.getByText("ログイン完了", { exact: true }).waitFor();
      await record("codex-done-before-http", panel);
      const arrived = page.waitForResponse(response => /\/login\/callback$/.test(response.url()));
      release.resolve(); await (await arrived).finished();
      assert.equal(await panel.locator("input").count(), 0); await record("codex-late-http-stays-done", panel);
      await context.unroute(callbackRoute, holdCallback); await cancel(panel, session);
      // Anthropic's native manual prompt takes precedence over the relay fallback.
      ({ session, panel } = await begin("Fixture Claude A", "Anthropic"));
      await popup(2, "/fixture-oauth");
      const manual = panel.getByRole("textbox", { name: "認証コード / ログイン後の戻り先URL全体", exact: true }); await manual.waitFor();
      assert.equal(await panel.getByRole("textbox", { name: "ログイン後の戻り先URL全体", exact: true }).count(), 0);
      await manual.fill("fixture-native-code#fixture-native-state"); await panel.getByRole("button", { name: "送信", exact: true }).click();
      await eventually(() => session.answer === "fixture-native-code#fixture-native-state", "Native code must go unchanged to /answer");
      await panel.locator("input").waitFor({ state: "detached" });
      assert.equal(await panel.getByText("ログイン完了", { exact: true }).count(), 0);
      fixture.oauth.done(session.id, { ok: false, error: "Fixture native login failed" });
      await panel.getByRole("alert").filter({ hasText: "Fixture native login failed" }).waitFor(); await record("anthropic-native-failure", panel);
      const staleSession = session; await cancel(panel, session);
      // Codex device flow is a notify/code display, not manual input or a callback POST.
      ({ session, panel } = await begin("Fixture Codex B", "OpenAI Codex"));
      await panel.getByRole("button", { name: "Fixture device login", exact: true }).click(); await popup(3, "/fixture-device");
      await panel.getByText("FIXT-ABCD", { exact: true }).waitFor(); assert.equal(await panel.locator("input").count(), 0);
      fixture.oauth.replayNotifications(session.id); fixture.oauth.done(staleSession.id, { ok: true }); await delay(300);
      assert.equal(popups.length, 3); assert.equal(await panel.getByText("ログイン完了", { exact: true }).count(), 0);
      await oneLoginStream(session); await record("device-ignores-stale-other-session", panel);
      fixture.oauth.done(session.id, { ok: true, warning: "Fixture account-scoped warning" });
      await panel.getByText("ログイン完了", { exact: true }).waitFor(); await panel.getByText("Fixture account-scoped warning", { exact: true }).waitFor();
      await record("device-success", panel); await cancel(panel, session);
      // Cancel while the POST is held: a late session must be DELETE'd without
      // reviving the panel, opening a popup or constructing an EventSource.
      const lateReceived = deferred(), lateRelease = deferred(); releases.push(lateRelease);
      const beginRoute = url => url.pathname === "/api/providers/openai-codex/login";
      const holdBegin = async route => { const response = await route.fetch(); lateReceived.resolve((await response.json()).sessionId); await lateRelease.promise; await route.fulfill({ response }); };
      await context.route(beginRoute, holdBegin);
      await card("Fixture Codex A").getByRole("button", { name: "再ログイン", exact: true }).click();
      const orphanId = await lateReceived.promise;
      await region("OpenAI Codex").getByRole("button", { name: "キャンセル", exact: true }).click();
      await region("OpenAI Codex").waitFor({ state: "detached" }); lateRelease.resolve();
      await eventually(() => fixture.oauth.sessions.get(orphanId).cancelled, "Late beginLogin must tear down its orphan session");
      await context.unroute(beginRoute, holdBegin);
      assert.equal(await region("OpenAI Codex").count(), 0); assert.equal(popups.length, 3);
      assert.equal(await page.evaluate(id => window.__sources.some(source => source.url.includes(`/login/events?sessionId=${id}`)), orphanId), false);
      steps.push({ name: "late-start-cancelled", orphanCancelled: true, loginPanel: false, popups: popups.length });
      // Unmount via real Login navigation; do not restore an old login session on remount.
      ({ session, panel } = await begin("Fixture Codex A", "OpenAI Codex"));
      await panel.getByRole("button", { name: "Fixture device login", exact: true }).click(); await popup(4, "/fixture-device");
      await oneLoginStream(session);
      await page.goto(origin + "/login"); await ready(page, "/login");
      await eventually(() => fixture.oauth.activeStreams(session.id) === 0, "Unmount must close the native login stream");
      await page.goto(origin + "/settings#models-providers"); await ready(page, "/settings"); await card("Fixture Codex A").waitFor();
      assert.equal(await region("OpenAI Codex").count(), 0);
      assert.equal(await page.evaluate(() => window.__sources.filter(source => source.url.includes("/login/events") && !source.closed).length), 0);
      fixture.oauth.done(session.id, { ok: false, error: "Fixture stale unmounted session" });
      ({ session, panel } = await begin("Fixture Codex A", "OpenAI Codex"));
      await panel.getByRole("button", { name: "Fixture browser login", exact: true }).click(); await popup(5, "/fixture-oauth");
      await panel.getByRole("textbox", { name: "ログイン後の戻り先URL全体", exact: true }).waitFor();
      await oneLoginStream(session); await record("remount-fresh-session", panel); await cancel(panel, session);
      const requests = fixture.log.slice(start).filter(item => /\/api\/providers\/[^/]+\/login/.test(item.path) && ["POST", "DELETE"].includes(item.method));
      assert.equal(requests.filter(item => item.path.endsWith("/login/callback")).length, 2);
      assert.equal(requests.filter(item => item.path.includes("/anthropic/login/callback")).length, 0);
      assert.equal(requests.find(item => item.path.endsWith("/anthropic/login/answer") && item.method === "POST").body.value, "fixture-native-code#fixture-native-state");
      evidence.push({ runtime: origin === nextOrigin ? "Next" : "SPA", size, steps, popupRecords, requests });
    } finally {
      for (const release of releases) release.resolve();
      await context.close(); fixture.oauth.reset();
    }
  };
  for (const [size, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    await checked(`Next ${size} provider-specific OAuth callback/device/lifecycle`, async () => run(nextOrigin, size, viewport));
    await checked(`SPA ${size} provider-specific OAuth callback/device/lifecycle`, async () => run(spaOrigin, size, viewport));
    await checked(`${size} provider-specific OAuth Next/SPA request, panel and popup parity`, async () => {
      const next = evidence.find(item => item.size === size && item.runtime === "Next"), spa = evidence.find(item => item.size === size && item.runtime === "SPA");
      assert.deepEqual(spa, { ...next, runtime: "SPA" });
    });
  }
  return evidence;
}
