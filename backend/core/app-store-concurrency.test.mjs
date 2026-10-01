import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppStore } from "./app-store.mjs";

// Each writer is a real independent Node process, sharing only the v1 file.
test("concurrent Web/Backend writers preserve every task and independent patches", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-store-concurrency-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "store.json");
  const options = { storePath: () => file, noProjectSessionDir: () => root, samePath: (a, b) => a === b, noProjectName: "none" };
  const store = new AppStore(options);
  const original = store.insertTask({ title: "original" });
  const moduleUrl = new URL("./app-store.mjs", import.meta.url).href;
  const children = ["web", "backend"].map((role) => {
    const code = `import { AppStore } from ${JSON.stringify(moduleUrl)};
const store = new AppStore({ storePath: () => ${JSON.stringify(file)}, noProjectSessionDir: () => ${JSON.stringify(root)}, samePath: (a,b) => a===b, noProjectName: 'none' });
process.on('message', () => {
  try {
    for (let i=0; i<40; i++) store.insertTask({ title: ${JSON.stringify(role)} + '-' + i });
    store.patchTask(${JSON.stringify(original.id)}, ${JSON.stringify(role === "web" ? { title: "manual title" } : { status: "working" })});
    process.disconnect();
  } catch (e) { console.error(e); process.exit(1); }
});
process.send('ready');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    return {
      child,
      ready: new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); }),
      done: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors || `writer exit ${code}`)));
      }),
    };
  });
  await Promise.all(children.map((item) => item.ready));
  children.forEach(({ child }) => child.send("start"));
  await Promise.all(children.map((item) => item.done));
  const fresh = new AppStore(options);
  assert.equal(fresh.listTasks(true, "all").length, 81);
  assert.equal(fresh.getTask(original.id).title, "manual title");
  assert.equal(fresh.getTask(original.id).status, "working");
  assert.equal(new Set(fresh.listTasks().map((task) => task.title)).size, 81);
  assert.equal(readdirSync(root).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")), false);
});
