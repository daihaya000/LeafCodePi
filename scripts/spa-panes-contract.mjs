import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Pane/tab interaction parity. Seeds the real localStorage layout and drives the
 * actual TaskTabs/PaneSection controls in both runtimes; pane ids are normalized
 * away, so only user-visible structure, URL and persisted shape are compared.
 * Only always-visible controls are used: the per-tab close button is hidden until
 * its tab is hovered, so pane removal is exercised through the empty-pane close.
 */
const SEED = {
  version: 1,
  panes: [
    { id: "p1", tabs: ["home", "task-a"], activeTabId: "home" },
    { id: "p2", tabs: ["task-b"], activeTabId: "task-b" },
  ],
  activePaneId: "p1",
  orientation: "horizontal",
};
const SEED_JSON = JSON.stringify(SEED);

export async function runPaneContracts({ pageFor, ready, checked, spaOrigin, nextOrigin }) {
  const evidence = [];
  const snapshot = page => page.evaluate(() => {
    const readStored = () => {
      try { return JSON.parse(localStorage.getItem("webui:task-panes") ?? "null"); } catch { return "invalid"; }
    };
    const stored = readStored();
    return {
      url: location.pathname + location.search + location.hash,
      historyLength: history.length,
      paneCount: document.querySelectorAll("[data-pane-id]").length,
      tablistCount: document.querySelectorAll('[role="tablist"]').length,
      panes: [...document.querySelectorAll("[data-pane-id]")].map(pane => ({
        active: pane.getAttribute("data-active") === "true",
        tabs: [...pane.querySelectorAll('[role="tab"]')].map(tab => ({
          label: tab.textContent?.trim().replace(/\s+/g, " "),
          selected: tab.getAttribute("aria-selected") === "true",
        })),
      })),
      // Pane ids are runtime-generated after "add pane"; compare the shape instead.
      storedPanes: Array.isArray(stored?.panes)
        ? { count: stored.panes.length, activeIndex: stored.panes.findIndex(pane => pane.id === stored.activePaneId), tabs: stored.panes.map(pane => pane.tabs) }
        : stored,
      separators: [...document.querySelectorAll('[role="separator"][aria-valuenow]')].map(separator => separator.getAttribute("aria-valuenow")),
    };
  });
  const record = async (steps, page, name) => { steps.push({ name, ...(await snapshot(page)) }); };
  const pane = (page, id) => page.locator(`[data-pane-id="${id}"]`);
  const waitPaneCount = (page, count) => page.waitForFunction(count => document.querySelectorAll("[data-pane-id]").length === count, count);
  // ready() targets task-a only; a restored layout may legitimately land on task-b.
  // Match the accessible heading name like ready() does (the h1 owns extra hover affordances).
  const waitTaskHeading = page => page.getByRole("heading", { name: /^Fixture task [12]$/ }).first().waitFor({ timeout: 20000 });
  // Tab labels fall back to the raw task id until /api/tasks resolves titles.
  // Wait for that asynchronous metadata so the comparison is not a timing race.
  const waitTabTitles = page => page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent?.trim() ?? "");
    return labels.length > 0 && labels.every(label => !/^task-/.test(label));
  }, undefined, { timeout: 20000 });

  const desktopRun = async origin => {
    const { page, context } = await pageFor(origin, { width: 1280, height: 900 }, { "webui:task-panes": SEED_JSON });
    const steps = [];
    try {
      await page.goto(origin + "/"); await ready(page, "/");
      await pane(page, "p2").waitFor();
      await pane(page, "p1").getByRole("tab", { name: "Fixture task 1", exact: true }).waitFor();
      await waitTabTitles(page);
      await record(steps, page, "restore");
      // Tab activation must replace the URL entry, not push a new one.
      await pane(page, "p1").getByRole("tab", { name: "Fixture task 1", exact: true }).click();
      await page.waitForFunction(() => location.pathname === "/task/task-a"); await ready(page, "/task/task-a");
      await record(steps, page, "activate-p1");
      await pane(page, "p2").getByRole("tab", { name: "Fixture task 2", exact: true }).click();
      await page.waitForFunction(() => location.pathname === "/task/task-b" && document.querySelector('[data-pane-id="p2"]')?.getAttribute("data-active") === "true");
      await waitTaskHeading(page);
      await record(steps, page, "activate-p2");
      const separator = page.locator('[role="separator"][aria-valuenow]').first();
      await separator.focus(); await separator.press("ArrowRight");
      await record(steps, page, "resize-keyboard");
      await page.getByRole("button", { name: "新しいペインを追加", exact: true }).click();
      await waitPaneCount(page, 3);
      await delay(700);
      await record(steps, page, "add-pane");
      await page.getByRole("button", { name: "空のペインを閉じる", exact: true }).click();
      await waitPaneCount(page, 2);
      await delay(700);
      await record(steps, page, "close-empty-pane");
      const settledUrl = steps.at(-1).url;
      await page.reload();
      await waitPaneCount(page, 2);
      await waitTabTitles(page);
      await waitTaskHeading(page);
      await record(steps, page, "reload-restore");
      const restoredUrl = steps.at(-1).url;
      await page.evaluate(() => history.pushState(null, "", "/bots"));
      await ready(page, "/bots");
      await page.goBack();
      await page.waitForFunction(url => location.pathname + location.search + location.hash === url, restoredUrl);
      await waitTaskHeading(page);
      await record(steps, page, "history-back");
      evidence.push({ size: "desktop", runtime: origin === nextOrigin ? "Next" : "SPA", steps, settledUrl, restoredUrl });
    } finally { await context.close(); }
  };
  await checked("Next desktop pane/tab activation, add, resize, close and history", async () => desktopRun(nextOrigin));
  const desktop = evidence.at(-1)?.steps;
  await checked("SPA desktop pane/tab activation, add, resize, close and history", async () => desktopRun(spaOrigin));
  await checked("desktop Next/SPA pane structure, URL and persisted layout parity", async () => {
    const steps = evidence.at(-1)?.steps;
    const next = evidence.find(item => item.size === "desktop" && item.runtime === "Next"), spa = evidence.at(-1);
    assert.deepEqual(steps, desktop);
    assert.equal(spa.settledUrl, next.settledUrl); assert.equal(spa.restoredUrl, next.restoredUrl);
    const named = Object.fromEntries(steps.map(step => [step.name, step]));
    assert.deepEqual(named.restore.storedPanes, { count: 2, activeIndex: 0, tabs: [["home", "task-a"], ["task-b"]] });
    assert.equal(named.restore.url, "/");
    assert.equal(named["activate-p1"].panes[0].tabs[1].selected, true);
    // replaceState keeps a single history entry for tab activation.
    assert.equal(named["activate-p1"].historyLength, named.restore.historyLength);
    assert.equal(named["activate-p1"].url, "/task/task-a");
    assert.equal(named["activate-p2"].panes[1].active, true);
    assert.equal(named["activate-p2"].url, "/task/task-b");
    assert.equal(named["activate-p2"].historyLength, named.restore.historyLength);
    assert.notEqual(named["resize-keyboard"].separators[0], named.restore.separators[0]);
    assert.equal(named["add-pane"].paneCount, 3);
    assert.equal(named["add-pane"].storedPanes.count, 3);
    assert.equal(named["close-empty-pane"].paneCount, 2);
    assert.equal(named["close-empty-pane"].storedPanes.count, 2);
    assert.equal(named["reload-restore"].paneCount, 2);
    assert.equal(named["reload-restore"].url, named["close-empty-pane"].url);
    assert.ok(named["reload-restore"].panes.some(candidate => candidate.active && candidate.tabs.some(tab => tab.selected && tab.label?.startsWith("Fixture task"))), "The saved active task tab must survive reload");
    assert.equal(named["history-back"].url, named["reload-restore"].url);
  });

  const mobileRun = async origin => {
    const { page, context } = await pageFor(origin, { width: 390, height: 844 }, { "webui:task-panes": SEED_JSON });
    const steps = [];
    try {
      for (const [path, name] of [["/task/task-a", "mobile-task"], ["/settings", "mobile-settings"], ["/", "mobile-home"]]) {
        await page.goto(origin + path); await ready(page, path);
        await record(steps, page, name);
        assert.equal(await page.evaluate(seed => localStorage.getItem("webui:task-panes"), SEED_JSON), SEED_JSON, `${name} must not persist a mobile layout`);
        // No split host below md; /settings has its own (unrelated) settings tablist.
        assert.equal(steps.at(-1).paneCount, 0);
      }
      await page.evaluate(() => history.pushState(null, "", "/bots/bot-a"));
      await ready(page, "/bots/bot-a");
      await record(steps, page, "mobile-bot");
      await page.goBack();
      await page.waitForFunction(() => location.pathname === "/"); await ready(page, "/");
      await record(steps, page, "mobile-back");
      evidence.push({ size: "mobile", runtime: origin === nextOrigin ? "Next" : "SPA", steps });
    } finally { await context.close(); }
  };
  await checked("Next mobile keeps the URL-driven single view and never rewrites the layout", async () => mobileRun(nextOrigin));
  const mobile = evidence.at(-1)?.steps;
  await checked("SPA mobile keeps the URL-driven single view and never rewrites the layout", async () => mobileRun(spaOrigin));
  await checked("mobile Next/SPA URL-driven view and untouched saved layout parity", async () => {
    assert.deepEqual(evidence.at(-1)?.steps, mobile);
    assert.deepEqual(mobile.map(step => step.url), ["/task/task-a", "/settings", "/", "/bots/bot-a", "/"]);
    assert.equal(mobile.find(step => step.name === "mobile-bot").paneCount, 0);
  });
  return evidence;
}
