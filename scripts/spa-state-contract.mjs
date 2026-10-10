import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const surfaces = [
  ["home", "/"], ["task", "/task/task-a"], ["bot", "/bots/bot-a"], ["room", "/bots/rooms/room-a"],
];
const local = JSON.stringify({ empty: "", zero: "0", flag: false, unicode: "日本語 😀" });
const session = "Fixture session lifetime 日本語 😀";
const forkKey = "webui.fork-draft.task-a", forkText = "Fixture one-shot fork draft";
const forkFile = { name: "fixture-fork.txt", mime: "text/plain", uri: "data:text/plain;base64,Zml4dHVyZS1mb3Jr" };
const draftText = name => `Fixture unsent ${name}\n日本語 😀`;
const fileName = name => `fixture-unsent-${name}.txt`;
const fileContent = name => `Fixture unsent attachment ${name} 日本語 😀`;

/** Existing memory-only drafts and one-shot session fork data; no send/provider operation. */
export async function runStateContracts({ pageFor, ready, checked, fixture, spaOrigin, nextOrigin }) {
  const evidence = [];
  const run = async (origin, size, viewport) => {
    fixture.reset(); const requestStart = fixture.log.length;
    const { page, context, flushResponses } = await pageFor(origin, viewport, { theme: "light", "fixture:state-local": local });
    const steps = [];
    let documentId;
    const editor = () => page.locator("textarea:visible").first();
    const remove = name => page.getByRole("button", { name: `${name}を削除`, exact: true }).filter({ visible: true });
    const storage = () => page.evaluate(key => ({ local: localStorage.getItem("fixture:state-local"), session: sessionStorage.getItem("fixture:state-session"), fork: sessionStorage.getItem(key) }), forkKey);
    const checkStorage = async () => assert.deepEqual(await storage(), { local, session, fork: null });
    const record = async (name, withEditor = false) => steps.push({ name,
      ...(withEditor ? { text: await editor().inputValue(), attachments: await page.locator('button[aria-label$="を削除"]:visible').evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")).filter(label => label.startsWith("fixture-"))) } : {}),
      ...(await page.evaluate(() => ({ theme: localStorage.getItem("theme"), classes: [...document.documentElement.classList].filter(name => ["light", "dark", "oyster"].includes(name)), colors: Object.fromEntries(["--bg", "--surface", "--text", "--bot-panel"].map(name => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])), colorScheme: document.documentElement.style.colorScheme }))),
      storage: await storage(),
    });
    const navigate = async path => {
      await flushResponses();
      if (size === "mobile" && path === "/") {
        // Native Next renders mobile Home from RSC children. Its real Link must
        // fetch those children after a Settings reload; raw pushState cannot.
        await page.getByRole("button", { name: "メニュー", exact: true }).first().click();
        const drawer = page.getByRole("dialog", { name: "ナビゲーション", exact: true });
        const code = drawer.getByRole("button", { name: /^Code(?:（|$)/ });
        if (await code.getAttribute("aria-pressed") !== "true") await code.click();
        await drawer.locator('a[href="/"]').first().click();
      } else await page.evaluate(path => history.pushState(null, "", path), path);
      await ready(page, path);
      assert.equal(await page.evaluate(() => window.__documentId), documentId, "Client navigation must not replace the document");
    };
    const privacy = async () => {
      const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      const requests = JSON.stringify(fixture.log.slice(requestStart));
      for (const [name] of surfaces) for (const marker of [draftText(name), fileName(name), fileContent(name), Buffer.from(fileContent(name)).toString("base64")]) {
        assert.equal(persisted.includes(JSON.stringify(marker).slice(1, -1)), false, "Unsent composer data must not be persisted");
        assert.equal(requests.includes(JSON.stringify(marker).slice(1, -1)), false, "Unsent composer data must not reach the owner");
      }
    };
    const restore = async (name, path, empty = false) => {
      await navigate(path); await editor().waitFor();
      assert.equal(await editor().inputValue(), empty ? "" : draftText(name));
      assert.equal(await remove(fileName(name)).count(), empty ? 0 : 1);
      await checkStorage(); await record(`${empty ? "reload-empty" : "restored"}-${name}`, true);
    };
    try {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(origin + "/"); await ready(page, "/"); documentId = await page.evaluate(() => window.__documentId);
      // These are fixture inputs to an existing real consumer, not new storage behavior.
      await page.evaluate(({ session, key, draft }) => {
        sessionStorage.setItem("fixture:state-session", session); sessionStorage.setItem(key, JSON.stringify(draft));
      }, { session, key: forkKey, draft: { text: forkText, images: [], files: [forkFile] } });
      for (const [name, path] of surfaces) {
        if (name !== "home") await navigate(path);
        await editor().waitFor();
        if (name === "task") {
          await page.waitForFunction(text => [...document.querySelectorAll("textarea")].some(input => input.value === text), forkText);
          assert.equal(await editor().inputValue(), forkText); await remove(forkFile.name).waitFor(); await checkStorage();
          await record("fork-consumed-once", true); await remove(forkFile.name).click();
        } else assert.equal(await editor().inputValue(), "", "Draft scopes must be isolated");
        await editor().fill(draftText(name));
        // The closest composer ancestor containing its file input works for both
        // form-based Home/Task and the existing div-based Bot/Room composers.
        const input = editor().locator('xpath=ancestor::*[.//input[@type="file"]][1]').locator('input[type="file"]').first();
        await input.setInputFiles({ name: fileName(name), mimeType: "text/plain", buffer: Buffer.from(fileContent(name)) });
        await remove(fileName(name)).waitFor(); await record(`filled-${name}`, true);
      }
      await privacy();
      // Navigate through non-composer views. Drafts belong to page-lifetime
      // module memory, not local/session storage or server settings.
      await navigate("/bots"); assert.equal(await page.locator("textarea:visible").count(), 0);
      await navigate("/settings");
      for (const [name, path] of surfaces) await restore(name, path);
      await privacy();
      await navigate("/settings"); const toggle = () => page.getByRole("button", { name: "テーマ切替", exact: true });
      assert.equal(await toggle().getAttribute("title"), "テーマ: light");
      await toggle().click(); await page.waitForFunction(() => localStorage.getItem("theme") === "dark" && document.documentElement.classList.contains("dark"));
      await record("theme-dark");
      // First actual reload drops every unsent draft, but preserves the selected
      // theme and the independent local/session values. Fork storage is consumed.
      const beforeReload = documentId; await page.reload(); await ready(page, "/settings"); documentId = await page.evaluate(() => window.__documentId); assert.notEqual(documentId, beforeReload);
      assert.equal(await toggle().getAttribute("title"), "テーマ: dark"); await checkStorage(); await record("theme-dark-reloaded");
      for (const [name, path] of surfaces) await restore(name, path, true);
      await privacy(); await navigate("/settings");
      for (const [theme, resolved] of [["oyster", "oyster"], ["system", "light"]]) {
        await toggle().click(); await page.waitForFunction(({ theme, resolved }) => localStorage.getItem("theme") === theme && document.documentElement.classList.contains(resolved), { theme, resolved });
        await record(`theme-${theme}`);
        await page.reload(); await ready(page, "/settings"); documentId = await page.evaluate(() => window.__documentId);
        assert.equal(await toggle().getAttribute("title"), `テーマ: ${theme}`); await checkStorage(); await record(`theme-${theme}-reloaded`);
      }
      await page.emulateMedia({ colorScheme: "dark" }); await page.waitForFunction(() => document.documentElement.classList.contains("dark")); await record("system-follows-dark");
      await page.emulateMedia({ colorScheme: "light" }); await page.waitForFunction(() => document.documentElement.classList.contains("light")); await record("system-follows-light");
      await toggle().click(); await page.waitForFunction(() => localStorage.getItem("theme") === "light" && document.documentElement.classList.contains("light")); await record("theme-light");
      await privacy(); await checkStorage();
      assert.equal(fixture.log.slice(requestStart).some(item => item.method === "POST" && (/\/api\/(tasks|bots)(?:\/|$)/.test(item.path))), false, "No task creation, fork or message submission is allowed");
      evidence.push({ runtime: origin === nextOrigin ? "Next" : "SPA", size, steps });
    } finally { await context.close(); }
  };
  for (const [size, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    await checked(`Next ${size} draft/theme/storage lifecycle`, async () => run(nextOrigin, size, viewport));
    await checked(`SPA ${size} draft/theme/storage lifecycle`, async () => run(spaOrigin, size, viewport));
    await checked(`${size} Next/SPA draft/theme/storage parity`, async () => {
      const next = evidence.find(item => item.size === size && item.runtime === "Next"), spa = evidence.find(item => item.size === size && item.runtime === "SPA");
      assert.deepEqual(spa, { ...next, runtime: "SPA" });
    });
  }
  return evidence;
}
