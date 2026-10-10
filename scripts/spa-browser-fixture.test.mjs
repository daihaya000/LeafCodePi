import assert from "node:assert/strict";
import test from "node:test";
import { startFixture, settings } from "./spa-browser-fixture.mjs";

async function withFixture(action) {
  const fixture = await startFixture();
  try { await action(fixture); } finally { await fixture.close(); }
}
const json = async (fixture, path, options) => (await fetch(fixture.origin + path, options)).json();
const put = body => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("notification fixture preserves OFF state in both owner response and saved settings", () => withFixture(async fixture => {
  assert.deepEqual(await json(fixture, "/api/notifications"), { enabled: false });
  assert.deepEqual(await json(fixture, "/api/notifications", put({ enabled: true })), { enabled: true });
  assert.equal((await json(fixture, "/api/settings")).values["pushover-notifications-enabled"], "1");
  await json(fixture, "/api/notifications", put({ enabled: false }));
  assert.equal((await json(fixture, "/api/settings")).values["pushover-notifications-enabled"], "0");
  const invalid = await fetch(fixture.origin + "/api/notifications", put({ enabled: "yes" }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await json(fixture, "/api/notifications"), { enabled: false });
}));

test("saved settings/sound writes stay isolated and reset never mutates the reference seed", () => withFixture(async fixture => {
  await json(fixture, "/api/settings/notification-sound-volume", put({ value: "12" }));
  assert.equal((await json(fixture, "/api/settings/notification-sound-volume")).value, "12");
  await json(fixture, "/api/settings", put({ values: { "task-pane-prefer-new": "1" } }));
  fixture.bot.notificationsEnabled = true;
  assert.equal((await json(fixture, "/api/bots")).bots[0].notificationsEnabled, true);
  assert.equal((await json(fixture, "/api/bots/sidebar")).bots[0].notificationsEnabled, true);
  assert.equal((await json(fixture, "/api/bots/sidebar")).rooms[0].members[0], fixture.bot.id);
  fixture.reset();
  assert.deepEqual((await json(fixture, "/api/settings")).values, settings);
  assert.equal(settings["notification-sound-volume"], "0");
  assert.equal((await json(fixture, "/api/bots/bot-a")).bot.notificationsEnabled, false);
}));

test("SSE injection targets only the named stream and reconnect replays the latest snapshot", () => withFixture(async fixture => {
  const path = "/api/bots/events", controller = new AbortController();
  const response = await fetch(fixture.origin + path, { signal: controller.signal });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
  assert.equal(fixture.activeStreams(path), 1);
  const next = { ...fixture.snapshotFor(path), bots: [{ ...fixture.bot, notificationsEnabled: true }] };
  const sequence = fixture.emit(path, "snapshot", next);
  assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(`"fixtureSequence":${sequence}`));
  fixture.emit("/api/bots/bot-a/events", "snapshot", { bot: fixture.bot });
  assert.equal(fixture.activeStreams("/api/bots/bot-a/events"), 0);
  fixture.disconnect(path);
  assert.equal((await reader.read()).done, true);
  const reopened = await fetch(fixture.origin + path, { signal: controller.signal });
  const replay = new TextDecoder().decode((await reopened.body.getReader().read()).value);
  assert.match(replay, new RegExp(`"fixtureSequence":${sequence}`));
  assert.match(replay, /"notificationsEnabled":true/);
  controller.abort();
}));
