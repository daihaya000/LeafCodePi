import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { stopOrphanedWebUi } from "./stale-webui.js";
test("Linux orphan cleanup admits only exact UUID gateway directories of this private generation root", async () => {
  const root = join(process.cwd(), "private-spa"), id = "12345678-1234-4123-8123-123456789abc", stopped = [];
  const cwd = { 1: join(root, "generations", id, "gateway"), 2: join(root + "-foreign", "generations", id, "gateway"), 3: join(root, "generations", id, "gateway", "nested"), 4: join(root, "generations", "not-a-generation", "gateway"), 5: join(root, "workspace", "web"), 6: join(root, "generations", id, "backend") };
  await stopOrphanedWebUi({ platform: "linux", selfPid: 99, port: 3010, projectDirs: [], generationRoot: root, getListeningPids: () => [1, 2, 3, 4, 5, 6], cwdOf: pid => cwd[pid], stopProcessTreeGracefully: async ({ pid }) => { stopped.push(pid); } });
  assert.deepEqual(stopped, [1]);
});
