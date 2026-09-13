import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const botApiTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../lib/paths", async (importOriginal) => { const actual = await importOriginal<typeof import("../../../lib/paths")>(); return { ...actual, dataDir: () => botApiTestState.root }; });
import { NextRequest } from "next/server";
import { insertTask, setTaskStatus } from "../../../lib/store";
import { GET, POST } from "./route";

describe("/api/bots", () => {
  let root = ""; beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-bots-")); botApiTestState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); botApiTestState.root = ""; });
  it("creates and lists bots", async () => {
    const response = await POST(new NextRequest("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Test bot" }) }));
    expect(response.status).toBe(201); const created = (await response.json()).bot;
    const listed = await GET(); expect((await listed.json()).bots[0].id).toBe(created.id);
  });
  it("counts only working Code sessions", async () => {
    const response = await POST(new NextRequest("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Working bot" }) }));
    const bot = (await response.json()).bot;
    insertTask({ project: null, title: "待機中", botId: bot.id });
    const working = insertTask({ project: null, title: "進行中", botId: bot.id });
    setTaskStatus(working.id, "working");
    const ready = insertTask({ project: null, title: "完了待ち", botId: bot.id });
    setTaskStatus(ready.id, "ready");
    const failed = insertTask({ project: null, title: "失敗", botId: bot.id });
    setTaskStatus(failed.id, "error");
    const aborted = insertTask({ project: null, title: "中断", botId: bot.id });
    setTaskStatus(aborted.id, "archived");

    const listed = await GET();
    expect((await listed.json()).bots[0].codeSessionCount).toBe(1);
  });
});
