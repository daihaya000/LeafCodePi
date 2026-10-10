import assert from "node:assert/strict";

const MIME = "application/x-leafcodepi-task";
const SEED = JSON.stringify({ version: 1, panes: [
  { id: "p1", tabs: ["home", "task-a"], activeTabId: "home" },
  { id: "p2", tabs: ["task-b"], activeTabId: "task-b" },
], activePaneId: "p1", orientation: "row" });

// Uses browser mouse input, never dispatchEvent, injected DataTransfer, force
// clicks or direct reducer/storage mutation after the initial saved-layout seed.
export async function runPointerContracts({ pageFor, ready, checked, spaOrigin, nextOrigin }) {
  const evidence = [];
  const tab = (page, title) => page.locator(`[role="tab"][title="${title}"]`);
  const pane = (page, id) => page.locator(`[data-pane-id="${id}"]`);
  const snapshot = page => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("webui:task-panes"));
    const index = id => stored.panes.findIndex(pane => pane.id === id);
    const layout = node => !node ? null : node.type === "pane"
      ? { type: "pane", index: index(node.paneId) }
      : { type: "split", orientation: node.orientation, children: node.children.map(layout) };
    return {
      url: location.pathname + location.search + location.hash,
      historyLength: history.length,
      panes: [...document.querySelectorAll("[data-pane-id]")].map(pane => ({
        active: pane.dataset.active === "true",
        tabs: [...pane.querySelectorAll('[role="tab"]')].map(tab => ({ title: tab.title, selected: tab.getAttribute("aria-selected") === "true" })),
      })),
      saved: { version: stored.version, activeIndex: index(stored.activePaneId), orientation: stored.orientation,
        panes: stored.panes.map(({ tabs, activeTabId }) => ({ tabs, activeTabId })), layout: layout(stored.layout) },
      separators: [...document.querySelectorAll('[role="separator"][aria-valuenow]')].map(node => ({ orientation: node.getAttribute("aria-orientation"), value: node.getAttribute("aria-valuenow") })),
    };
  });
  const waitSaved = (page, tabs) => page.waitForFunction(tabs => {
    const saved = JSON.parse(localStorage.getItem("webui:task-panes") ?? "null");
    return JSON.stringify(saved?.panes.map(pane => pane.tabs)) === JSON.stringify(tabs);
  }, tabs, { timeout: 15000 });
  const record = async (steps, page, name, tabs) => {
    await waitSaved(page, tabs);
    steps.push({ name, ...(await snapshot(page)) });
  };
  const drag = async (page, source, target, position) => {
    await source.scrollIntoViewIfNeeded();
    const from = await source.boundingBox(), to = await target.boundingBox();
    assert.ok(from && to, "Drag endpoints must be rendered");
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const end = { x: to.x + to.width * position.x, y: to.y + to.height * position.y };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    try {
      await page.mouse.move(start.x + 10, start.y + 6, { steps: 3 });
      await page.mouse.move(end.x, end.y, { steps: 12 });
      // Chromium requires a second target move to deliver dragover reliably.
      await page.mouse.move(end.x + 1, end.y + 1);
      await page.mouse.move(end.x, end.y);
    } finally { await page.mouse.up(); }
  };
  const closeHovered = async (page, title) => {
    // Hover exposes a labelled button and changes the tab's accessible name.
    // The stable title attribute avoids re-resolving an obsolete exact role name.
    const target = tab(page, title);
    await target.hover();
    const close = target.getByRole("button", { name: `タブ ${title} を閉じる`, exact: true });
    await close.waitFor({ state: "visible", timeout: 5000 });
    await close.click();
  };
  const run = async origin => {
    const { page, context } = await pageFor(origin, { width: 1280, height: 900 }, { "webui:task-panes": SEED });
    const steps = [];
    await context.addInitScript(() => {
      window.__pointerDrags = [];
      for (const type of ["dragstart", "drop", "dragend"]) document.addEventListener(type, event => {
        window.__pointerDrags.push({ type, trusted: event.isTrusted, types: [...event.dataTransfer.types],
          task: type === "drop" ? event.dataTransfer.getData("application/x-leafcodepi-task") : null });
      }, true);
    });
    try {
      await page.goto(origin + "/"); await ready(page, "/");
      await tab(page, "Fixture task 1").waitFor(); await tab(page, "Fixture task 2").waitFor();
      await record(steps, page, "restore", [["home", "task-a"], ["task-b"]]);
      await drag(page, tab(page, "Fixture task 1"), tab(page, "新規作成"), { x: 0.3, y: 0.5 });
      await page.waitForFunction(() => document.querySelector('[data-pane-id="p1"] [role="tab"]')?.title === "Fixture task 1");
      await record(steps, page, "reorder", [["task-a", "home"], ["task-b"]]);
      const handle = page.locator('[role="separator"][aria-valuenow]').first();
      const box = await handle.boundingBox(); assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      try { await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 }); }
      finally { await page.mouse.up(); }
      await record(steps, page, "resize-pointer", [["task-a", "home"], ["task-b"]]);
      assert.notEqual(steps.at(-1).separators[0].value, steps[0].separators[0].value);
      assert.deepEqual(await page.evaluate(() => ({ select: document.body.style.userSelect, cursor: document.body.style.cursor })), { select: "", cursor: "" });
      await drag(page, tab(page, "Fixture task 2"), tab(page, "新規作成"), { x: 0.3, y: 0.5 });
      await record(steps, page, "move-between-panes", [["task-a", "home", "task-b"]]);
      await drag(page, tab(page, "Fixture task 1"), pane(page, "p1"), { x: 0.98, y: 0.4 });
      await record(steps, page, "right-edge-split", [["home", "task-b"], ["task-a"]]);
      await closeHovered(page, "Fixture task 2");
      await record(steps, page, "hover-close-inactive", [["home"], ["task-a"]]);
      const trustedDrags = await page.evaluate(() => window.__pointerDrags);
      const drops = trustedDrags.filter(event => event.type === "drop");
      assert.deepEqual(drops.map(event => event.task), ["task-a", "task-b", "task-a"]);
      assert.equal(trustedDrags.filter(event => event.type === "dragstart").length, 3);
      // Moving/splitting unmounts the original draggable before dragend; detached
      // source events need not bubble to document. Completed trusted drops prove
      // those gestures; the in-place reorder also exercises the attached dragend.
      assert.ok(trustedDrags.some(event => event.type === "dragend"));
      assert.ok(trustedDrags.every(event => event.trusted), "All drag events must come from actual browser mouse input");
      assert.ok(drops.every(event => event.types.includes(MIME)), "The app must supply its real custom drag MIME");
      await page.reload();
      await tab(page, "Fixture task 1").waitFor(); await tab(page, "新規作成").waitFor();
      await record(steps, page, "split-reload", [["home"], ["task-a"]]);
      await pane(page, "p1").getByRole("button", { name: "このペインを一括クリア", exact: true }).click();
      await record(steps, page, "clear-home-pane", [["task-a"]]);
      await closeHovered(page, "Fixture task 1");
      // Existing minimum-one-pane behavior: closing its only tab is a no-op.
      await record(steps, page, "close-last-pane-guard", [["task-a"]]);
      assert.deepEqual(steps.at(-1).saved, steps.at(-2).saved);
      await page.getByRole("button", { name: "新規作成タブを開く", exact: true }).click();
      await ready(page, "/");
      await record(steps, page, "open-home", [["task-a", "home"]]);
      await closeHovered(page, "Fixture task 1");
      await record(steps, page, "close-with-home-fallback", [["home"]]);
      await page.reload(); await ready(page, "/");
      await record(steps, page, "final-reload", [["home"]]);
      evidence.push({ runtime: origin === nextOrigin ? "Next" : "SPA", steps, trustedDrags });
    } finally { await context.close(); }
  };
  await checked("Next desktop real-pointer drag/drop, hover close, clear and restore", async () => run(nextOrigin));
  await checked("SPA desktop real-pointer drag/drop, hover close, clear and restore", async () => run(spaOrigin));
  await checked("desktop real-pointer Next/SPA layout, URL and saved-state parity", async () => {
    const [next, spa] = evidence;
    assert.deepEqual(spa, { ...next, runtime: "SPA" });
    const named = Object.fromEntries(spa.steps.map(step => [step.name, step]));
    assert.equal(named.reorder.historyLength, named.restore.historyLength);
    assert.equal(named["move-between-panes"].url, "/task/task-b");
    assert.equal(named["right-edge-split"].url, "/task/task-a");
    assert.deepEqual(named["right-edge-split"].saved.layout, { type: "split", orientation: "row", children: [{ type: "pane", index: 0 }, { type: "pane", index: 1 }] });
    assert.deepEqual(named["split-reload"].saved, named["hover-close-inactive"].saved);
    assert.equal(named["split-reload"].url, named["hover-close-inactive"].url);
    assert.deepEqual(named["final-reload"].saved, named["close-with-home-fallback"].saved);
    assert.equal(named["final-reload"].url, "/");
  });
  return evidence;
}
