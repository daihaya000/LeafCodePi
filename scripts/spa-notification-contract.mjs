import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Browser boundary instrumentation, not an OS toast/speaker/permission-dialog assertion. */
export function installNotificationProbe() {
  const Native = window.Notification, Source = window.EventSource;
  const probe = window.__notificationProbe = { hidden: false, permission: null, permissionRequests: 0, records: [], frames: [], audioContexts: 0 };
  Object.defineProperty(document, "hidden", { configurable: true, get: () => probe.hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => probe.hidden ? "hidden" : "visible" });
  if (Native) window.Notification = class extends Native {
    static get permission() { return probe.permission ?? Native.permission; }
    static requestPermission() { probe.permissionRequests++; return Promise.resolve(probe.permission ?? Native.permission); }
    constructor(title, options) {
      super(title, options);
      probe.records.push({ title, body: options?.body, tag: options?.tag, nativePermission: Native.permission });
      this.close(); // Do not leave test toasts on the desktop.
    }
  };
  window.EventSource = class extends Source {
    constructor(url, options) {
      super(url, options);
      for (const name of ["snapshot", "routine"]) this.addEventListener(name, event => {
        try { probe.frames.push({ path: new URL(url, location.href).pathname, sequence: JSON.parse(event.data).fixtureSequence }); } catch {}
      });
    }
  };
  if (window.AudioContext) {
    const Audio = window.AudioContext;
    window.AudioContext = class extends Audio { constructor(...args) { super(...args); probe.audioContexts++; } };
  }
}
const sharedPath = "/api/bots/events";
const routine = { botId: "bot-a", botName: "Fixture Bot", routineId: "fixture-routine", routineName: "Fixture routine", ok: true, at: "2026-01-01T00:00:01.000Z", preview: "Fixture result", error: null, failureCount: 0, autoDisabled: false };
const permission = { id: "fixture-permission", sessionId: "fixture", command: "fixture_read", message: "Fixture approval only", labels: [] };

export async function runNotificationContracts({ pageFor, ready, checked, fixture, spaOrigin, nextOrigin }) {
  const evidence = [];
  const open = async (origin, viewport, seed = {}) => {
    const result = await pageFor(origin, viewport, seed);
    await result.context.grantPermissions(["notifications"], { origin });
    await result.context.addInitScript(installNotificationProbe);
    return result;
  };
  const hidden = (page, value) => page.evaluate(value => { window.__notificationProbe.hidden = value; document.dispatchEvent(new Event("visibilitychange")); }, value);
  const count = page => page.evaluate(() => window.__notificationProbe.records.length);
  const emit = async (page, path, event, body) => {
    const sequence = fixture.emit(path, event, body);
    await page.waitForFunction(({ path, sequence }) => window.__notificationProbe.frames.some(frame => frame.path === path && frame.sequence === sequence), { path, sequence });
    // EventSource delivery precedes React's commit; negatives use a finite settling window.
    await delay(200);
  };
  const expectedCount = async (page, value) => {
    await page.waitForFunction(value => window.__notificationProbe.records.length >= value, value);
    assert.equal(await count(page), value, "No duplicated notification constructor calls");
  };
  const loadedToggle = page => page.locator('button[aria-label^="通知を"][aria-label$="（ブラウザ・Pushover）"]').first();
  const ensureLoaded = async page => {
    // The mobile drawer does not mount its footer until opened by the user.
    const menu = page.getByRole("button", { name: "メニュー", exact: true }).first();
    if (!await loadedToggle(page).count() && await menu.isVisible()) await menu.click();
    await loadedToggle(page).waitFor({ state: "attached" });
    const pressed = await loadedToggle(page).getAttribute("aria-pressed");
    const close = page.getByRole("dialog", { name: "ナビゲーション", exact: true }).getByRole("button", { name: "メニューを閉じる", exact: true });
    if (await close.isVisible()) await close.click();
    return pressed;
  };
  const toggle = async page => {
    const button = loadedToggle(page);
    if (!await button.isVisible()) await page.getByRole("button", { name: "メニュー", exact: true }).first().click();
    await button.click();
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label^="通知を"]')].some(button => !button.disabled));
    const close = page.getByRole("dialog", { name: "ナビゲーション", exact: true }).getByRole("button", { name: "メニューを閉じる", exact: true });
    if (await close.isVisible()) await close.click();
  };
  const fresh = () => { fixture.reset(); fixture.bot.notificationsEnabled = true; fixture.values["pushover-notifications-enabled"] = "1"; };
  for (const [size, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const paired = [];
    for (const [runtime, origin] of [["Next", nextOrigin], ["SPA", spaOrigin]]) await checked(`${runtime} ${size} task/Bot/Room/routine notification delivery and suppression`, async () => {
      fresh(); const { page, context } = await open(origin, viewport); const producerRecords = {};
      const capture = async name => { producerRecords[name] = await page.evaluate(() => ({ records: window.__notificationProbe.records, audioContexts: window.__notificationProbe.audioContexts })); };
      try {
        await page.goto(origin + "/task/task-a"); await ready(page, "/task/task-a");
        assert.equal(await ensureLoaded(page), "true");
        assert.equal(await page.evaluate(() => Notification.permission), "granted");
        const taskPath = "/api/tasks/task-a/events", task = fixture.snapshotFor(taskPath);
        const cycle = async (path, baseline) => {
          await emit(page, path, "snapshot", { ...baseline, task: baseline.task && { ...baseline.task, status: "working" }, isStreaming: true });
          await emit(page, path, "snapshot", { ...baseline, isStreaming: false });
        };
        await hidden(page, true); await cycle(taskPath, task); await expectedCount(page, 1);
        await emit(page, taskPath, "snapshot", task); await expectedCount(page, 1);
        await emit(page, taskPath, "snapshot", { ...task, permissionRequest: permission }); await expectedCount(page, 2);
        await emit(page, taskPath, "snapshot", { ...task, permissionRequest: null });
        await hidden(page, false); await cycle(taskPath, task); assert.equal(await count(page), 2);
        await page.evaluate(() => { window.__notificationProbe.permission = "denied"; });
        await hidden(page, true); await cycle(taskPath, task); assert.equal(await count(page), 2);
        await capture("task");
        await page.evaluate(() => localStorage.removeItem("webui:task-panes"));
        await page.goto(origin + "/bots/bot-a"); await ready(page, "/bots/bot-a"); assert.equal(await ensureLoaded(page), "true");
        await hidden(page, true);
        const botPath = "/api/bots/bot-a/events", bot = fixture.snapshotFor(botPath);
        await cycle(botPath, bot); await expectedCount(page, 1);
        await emit(page, botPath, "snapshot", { ...bot, permissionRequest: permission }); await expectedCount(page, 2);
        await emit(page, botPath, "snapshot", { ...bot, permissionRequest: null });
        await emit(page, sharedPath, "routine", routine); assert.equal(await count(page), 2, "Inline Bot owns delivery, not the global routine subscriber");
        await capture("bot");
        await page.evaluate(() => localStorage.removeItem("webui:task-panes"));
        await page.goto(origin + "/bots/rooms/room-a"); await ready(page, "/bots/rooms/room-a"); assert.equal(await ensureLoaded(page), "true");
        await hidden(page, true);
        const roomPath = "/api/bots/rooms/room-a/events", room = fixture.snapshotFor(roomPath);
        await emit(page, roomPath, "snapshot", { ...room, room: { ...room.room, messages: [{ id: "fixture-reply", role: "assistant", botId: "bot-a", text: "Fixture work", status: "working", createdAt: 1 }] } });
        await emit(page, roomPath, "snapshot", room); await expectedCount(page, 1);
        await emit(page, roomPath, "snapshot", { ...room, attention: [{ botId: "bot-a", taskId: "fixture", permission, question: null }] }); await expectedCount(page, 2);
        await emit(page, roomPath, "snapshot", room);
        await capture("room");
        await page.evaluate(() => localStorage.removeItem("webui:task-panes"));
        await page.goto(origin + "/bots"); await ready(page, "/bots"); assert.equal(await ensureLoaded(page), "true");
        await hidden(page, true); await emit(page, sharedPath, "routine", routine); await expectedCount(page, 1);
        await hidden(page, false); await emit(page, sharedPath, "routine", routine); assert.equal(await count(page), 1);
        await page.evaluate(() => { window.__notificationProbe.permission = "default"; });
        await emit(page, sharedPath, "routine", routine); await emit(page, sharedPath, "routine", routine);
        assert.equal(await page.evaluate(() => window.__notificationProbe.permissionRequests), 1, "One routine permission request per document");
        await page.evaluate(() => { window.__notificationProbe.permission = "denied"; });
        await hidden(page, true); await emit(page, sharedPath, "routine", routine); assert.equal(await count(page), 1);
        const result = await page.evaluate(() => ({ records: window.__notificationProbe.records, permissionRequests: window.__notificationProbe.permissionRequests, audioContexts: window.__notificationProbe.audioContexts }));
        paired.push({ ...result, producerRecords }); evidence.push({ size, runtime, ...result, producerRecords });
      } finally { await context.close(); fixture.reset(); }
    });
    await checked(`${size} Next/SPA notification permission/title/body/tag parity`, async () => assert.deepEqual(paired[1], paired[0]));
    await checked(`SPA ${size} notification OFF persistence, shared reconnect and Login remount`, async () => {
      fresh(); const { page, context } = await open(spaOrigin, viewport);
      try {
        await page.goto(spaOrigin + "/bots"); await ready(page, "/bots"); assert.equal(await ensureLoaded(page), "true");
        await hidden(page, true); await emit(page, sharedPath, "routine", routine); await expectedCount(page, 1);
        await hidden(page, false); await toggle(page);
        assert.equal(fixture.values["pushover-notifications-enabled"], "0");
        await hidden(page, true); await emit(page, sharedPath, "routine", routine); assert.equal(await count(page), 1);
        await page.evaluate(() => { history.pushState(null, "", "/settings#prompts"); }); await ready(page, "/settings");
        await emit(page, sharedPath, "routine", routine); assert.equal(await count(page), 1);
        await hidden(page, false); await toggle(page);
        assert.equal(fixture.values["pushover-notifications-enabled"], "1");
        await hidden(page, true); await emit(page, sharedPath, "routine", routine); await expectedCount(page, 2);
        fixture.disconnect(sharedPath);
        await page.waitForFunction(() => window.__sources.filter(source => new URL(source.url, location.href).pathname === "/api/bots/events").some(source => source.closed));
        for (let i = 0; i < 100 && fixture.activeStreams(sharedPath) !== 1; i++) await delay(50);
        assert.equal(fixture.activeStreams(sharedPath), 1); await emit(page, sharedPath, "routine", routine); await expectedCount(page, 3);
        await page.evaluate(() => { history.pushState(null, "", "/login"); }); await ready(page, "/login");
        await page.waitForFunction(() => window.__sources.filter(source => new URL(source.url, location.href).pathname === "/api/bots/events" && !source.closed).length === 0);
        await page.evaluate(() => { history.pushState(null, "", "/bots"); }); await ready(page, "/bots");
        await emit(page, sharedPath, "routine", routine); await expectedCount(page, 4);
        assert.equal(await page.evaluate(() => window.__sources.filter(source => new URL(source.url, location.href).pathname === "/api/bots/events" && !source.closed).length), 1);
        await hidden(page, false); await toggle(page); await page.reload(); await ready(page, "/bots");
        assert.equal(await ensureLoaded(page), "false");
        await hidden(page, true); await emit(page, sharedPath, "routine", routine); assert.equal(await count(page), 0);
      } finally { await context.close(); fixture.reset(); }
    });
    await checked(`SPA ${size} saved notification OFF admission before footer/default writers`, async () => {
      fresh(); fixture.values["pushover-notifications-enabled"] = "0";
      const { page, context } = await open(spaOrigin, viewport, { "webui:notification-sound-volume": "100", "webui:notification-sound-type": "clear" });
      let release; const held = new Promise(resolve => { release = resolve; }); const start = fixture.log.length;
      await context.route("**/api/settings", async route => { await held; await route.fallback(); });
      // Hold the independent status request after admission: the saved settings must already mute delivery.
      let footerRelease; const footerHeld = new Promise(resolve => { footerRelease = resolve; });
      await context.route("**/api/notifications", async route => { await footerHeld; await route.fallback(); });
      try {
        await page.goto(spaOrigin + "/bots"); await delay(300);
        assert.equal(fixture.log.slice(start).some(item => item.path.startsWith("/api/settings/") || item.path === sharedPath || item.path === "/api/notifications"), false);
        assert.equal(await page.evaluate(() => window.__sources.length), 0);
        release(); await ready(page, "/bots"); await hidden(page, true);
        await emit(page, sharedPath, "routine", routine); assert.equal(await count(page), 0);
        assert.equal(await page.evaluate(() => window.__notificationProbe.audioContexts), 0);
        assert.equal(await page.evaluate(() => localStorage.getItem("webui:notification-sound-volume")), "0");
        footerRelease(); assert.equal(await ensureLoaded(page), "false");
        for (const item of fixture.log.slice(start).filter(item => item.method === "PUT" && item.path.startsWith("/api/settings/notification-sound"))) assert.equal(item.body.value, fixture.values[item.path.split("/").at(-1)]);
      } finally { release(); footerRelease(); await context.close(); fixture.reset(); }
    });
  }
  return evidence;
}
