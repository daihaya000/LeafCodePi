import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const botApiTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../lib/paths", async (importOriginal) => { const actual = await importOriginal<typeof import("../../../lib/paths")>(); return { ...actual, dataDir: () => botApiTestState.root }; });
import { NextRequest } from "next/server";
import { insertTask, setTaskStatus } from "../../../lib/store";
import { MAX_BOT_NAME_CHARS } from "../../../lib/bots";
import { GET, POST } from "./route";

const backendClientMock = vi.hoisted(() => ({
  readBackendBots: vi.fn(),
  readBackendTasks: vi.fn(),
  readBackendHealth: vi.fn(),
  expectedBackendGeneration: vi.fn(() => ""),
}));
vi.mock("../../../lib/backend-client", () => backendClientMock);

describe("/api/bots", () => {
  let root = ""; beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-bots-")); botApiTestState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); botApiTestState.root = ""; });
  it("creates and lists bots", async () => {
    const response = await POST(new NextRequest("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Test bot" }) }));
    expect(response.status).toBe(201); const created = (await response.json()).bot;
    const listed = await GET(); expect((await listed.json()).bots[0].id).toBe(created.id);
  });
  it("rejects an oversized name before creating a bot", async () => {
    const response = await POST(new NextRequest("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "x".repeat(MAX_BOT_NAME_CHARS + 1) }) }));
    expect(response.status).toBe(400);
    const listed = await GET();
    expect((await listed.json()).bots).toEqual([]);
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

describe("/api/bots relay", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-bots-relay-")); botApiTestState.root = root; });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    botApiTestState.root = "";
    delete process.env.LEAFCODE_PI_BACKEND_OWNS_RUNTIME;
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
  });
  /** A WebUI that handed the runtime over: not an owner, and not the runtime host either. */
  const clientEnv = () => {
    process.env.LEAFCODE_PI_BACKEND_OWNS_RUNTIME = "1";
    delete process.env.LEAFCODE_PI_BACKEND_RUNTIME;
  };
  it("serves the Backend Bot view while this process is a client", async () => {
    clientEnv();
    const { readBackendBots, readBackendTasks } = await import("../../../lib/backend-client");
    vi.mocked(readBackendBots).mockResolvedValue({ ok: true, status: 200, body: { bots: [{ id: "bot-remote", name: "Backend bot" }] } } as never);
    vi.mocked(readBackendTasks).mockResolvedValue({ ok: true, status: 200, body: { tasks: [{ id: "t1", status: "working", botId: "bot-remote" }] } } as never);
    const listed = await GET();
    expect(await listed.json()).toEqual({ bots: [{ id: "bot-remote", name: "Backend bot", codeSessionCount: 1 }] });
  });
  it("reports a failing Backend instead of the local list for a client", async () => {
    clientEnv();
    const response = await POST(new NextRequest("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Local bot" }) }));
    expect(response.status).toBe(201);
    const { readBackendBots, readBackendTasks } = await import("../../../lib/backend-client");
    vi.mocked(readBackendBots).mockResolvedValue({ ok: false, reason: "unreachable" } as never);
    vi.mocked(readBackendTasks).mockResolvedValue({ ok: true, status: 200, body: { tasks: [] } } as never);
    const listed = await GET();
    expect(listed.status).toBe(503);
    await expect(listed.json()).resolves.toEqual({ error: "BackendのBot一覧を取得できません" });
  });
  it("keeps the in-process list while this process owns the runtime", async () => {
    const response = await POST(new NextRequest("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Local bot" }) }));
    const bot = (await response.json()).bot;
    const { readBackendBots } = await import("../../../lib/backend-client");
    vi.mocked(readBackendBots).mockClear();
    const listed = await GET();
    const bots = (await listed.json()).bots;
    expect(bots.map((item: { id: string }) => item.id)).toEqual([bot.id]);
    expect(bots[0].codeSessionCount).toBe(0);
    expect(vi.mocked(readBackendBots)).not.toHaveBeenCalled();
  });
});
