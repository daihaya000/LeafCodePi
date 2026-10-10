import { BackendTestRequest as Request } from "@/test-request";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const botApiTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../lib/paths", async (importOriginal) => { const actual = await importOriginal<typeof import("../../../lib/paths")>(); return { ...actual, dataDir: () => botApiTestState.root }; });
import { insertTask, setTaskStatus } from "../../../lib/store";
import { MAX_BOT_NAME_CHARS } from "../../../lib/bots";
import { GET, POST } from "@backend-runtime/json-business/handlers/bots/route";

const backendClientMock = vi.hoisted(() => ({
  readBackendBots: vi.fn(),
  readBackendTasks: vi.fn(),
  readBackendHealth: vi.fn(),
  expectedBackendGeneration: vi.fn(() => ""),
}));
vi.mock("../../../lib/backend-client", () => backendClientMock);

describe("/api/bots", () => {
  let root = ""; beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-bots-")); botApiTestState.root = root; vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "attach"); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); botApiTestState.root = ""; vi.unstubAllEnvs(); });
  it("creates and lists bots", async () => {
    const response = await POST(new Request("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Test bot" }) }));
    expect(response.status).toBe(201); const created = (await response.json()).bot;
    const listed = await GET(); expect((await listed.json()).bots[0].id).toBe(created.id);
  });
  it("rejects an oversized name before creating a bot", async () => {
    const response = await POST(new Request("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "x".repeat(MAX_BOT_NAME_CHARS + 1) }) }));
    expect(response.status).toBe(400);
    const listed = await GET();
    expect((await listed.json()).bots).toEqual([]);
  });

  it("counts only working Code sessions", async () => {
    const response = await POST(new Request("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Working bot" }) }));
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
