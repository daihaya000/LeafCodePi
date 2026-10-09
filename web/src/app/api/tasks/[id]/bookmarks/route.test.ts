import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PUT } from "@backend-runtime/json-business/handlers/tasks/[id]/bookmarks/route";

const TASK = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTasks: vi.fn(),
  readTaskTranscript: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask, listTasks: mocks.listTasks }));
vi.mock("@/lib/task-transcript", () => ({ readTaskTranscript: mocks.readTaskTranscript }));

const context = (id = TASK) => ({ params: Promise.resolve({ id }) });
const url = (suffix = "") => `http://127.0.0.1:3010/api/tasks/${TASK}/bookmarks${suffix}`;

function put(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url(), {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const bookmark = (messageId: string, overrides: Record<string, unknown> = {}) => ({
  messageId,
  role: "assistant",
  messageCreatedAt: 100,
  preview: `preview ${messageId}`,
  ...overrides,
});

describe("/api/tasks/[id]/bookmarks", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-bookmarks-route-"));
    process.env.LEAFCODE_PI_DATA_DIR = dataDir;
    mocks.getTask.mockReset().mockImplementation((id: string) => (id === TASK ? { id } : undefined));
    mocks.listTasks.mockReset().mockReturnValue([{ id: TASK }]);
    mocks.readTaskTranscript.mockReset();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts empty, adds, lists in timeline order and removes", async () => {
    expect(await (await GET(new NextRequest(url()), context())).json()).toEqual({ bookmarks: [] });

    const added = await PUT(put(bookmark("late", { messageCreatedAt: 300 })), context());
    expect(added.status).toBe(200);
    await PUT(put(bookmark("early", { role: "user", messageCreatedAt: 100 })), context());
    const listed = await (await GET(new NextRequest(url()), context())).json();
    expect(listed.bookmarks.map((entry: { messageId: string }) => entry.messageId)).toEqual(["early", "late"]);
    expect(listed.bookmarks[0]).toMatchObject({ role: "user", preview: "preview early" });

    const removed = await DELETE(
      new NextRequest(url("?messageId=early"), { method: "DELETE" }),
      context(),
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).bookmarks.map((entry: { messageId: string }) => entry.messageId)).toEqual(["late"]);
  });

  it("verify=1 reports bookmarks whose message is no longer in the session", async () => {
    await PUT(put(bookmark("kept", { messageCreatedAt: 1 })), context());
    await PUT(put(bookmark("gone", { messageCreatedAt: 2 })), context());
    mocks.readTaskTranscript.mockResolvedValue({ ok: true, messages: [{ id: "kept" }, { id: "other" }] });

    const verified = await (await GET(new NextRequest(url("?verify=1")), context())).json();
    expect(verified.bookmarks).toHaveLength(2);
    expect(verified.missing).toEqual(["gone"]);
    expect(mocks.readTaskTranscript).toHaveBeenCalledWith(TASK);

    // A plain read never touches the transcript.
    mocks.readTaskTranscript.mockClear();
    const plain = await (await GET(new NextRequest(url()), context())).json();
    expect(plain).not.toHaveProperty("missing");
    expect(mocks.readTaskTranscript).not.toHaveBeenCalled();
  });

  it("verification is best effort: an unreadable transcript leaves missing out", async () => {
    await PUT(put(bookmark("a")), context());
    mocks.readTaskTranscript.mockResolvedValueOnce({ ok: false, status: 502, body: {} });
    expect(await (await GET(new NextRequest(url("?verify=1")), context())).json()).not.toHaveProperty("missing");
    mocks.readTaskTranscript.mockRejectedValueOnce(new Error("boom"));
    const failed = await GET(new NextRequest(url("?verify=1")), context());
    expect(failed.status).toBe(200);
    expect(await failed.json()).not.toHaveProperty("missing");
  });

  it("verify=1 skips the transcript when there is nothing to verify", async () => {
    expect(await (await GET(new NextRequest(url("?verify=1")), context())).json()).toEqual({ bookmarks: [] });
    expect(mocks.readTaskTranscript).not.toHaveBeenCalled();
  });

  it("adding the same message twice keeps one bookmark", async () => {
    await PUT(put(bookmark("a")), context());
    const second = await (await PUT(put(bookmark("a", { preview: "other" })), context())).json();
    expect(second.bookmarks).toHaveLength(1);
    expect(second.bookmarks[0].preview).toBe("preview a");
  });

  it("answers 404 for an unknown task or an id that cannot address bookmarks", async () => {
    expect((await GET(new NextRequest(url()), context("missing"))).status).toBe(404);
    expect((await PUT(put(bookmark("a")), context("missing"))).status).toBe(404);
    expect((await DELETE(new NextRequest(url("?messageId=a"), { method: "DELETE" }), context("missing"))).status).toBe(404);
    expect((await GET(new NextRequest(url()), context("../evil"))).status).toBe(404);
    expect(mocks.getTask).not.toHaveBeenCalledWith("../evil");
  });

  it("rejects malformed bodies and messages that cannot be bookmarked", async () => {
    expect((await PUT(put("not json"), context())).status).toBe(400);
    expect((await PUT(put([1, 2]), context())).status).toBe(400);
    expect((await PUT(put(bookmark("msg-4")), context())).status).toBe(400);
    expect((await PUT(put(bookmark("a", { role: "system" })), context())).status).toBe(400);
    expect((await PUT(put({ role: "user" }), context())).status).toBe(400);
    expect((await PUT(put("x".repeat(5_000)), context())).status).toBe(413);
    expect((await DELETE(new NextRequest(url(), { method: "DELETE" }), context())).status).toBe(400);
  });

  it("refuses cross-site writes without touching the store", async () => {
    const blocked = await PUT(put(bookmark("a"), { "sec-fetch-site": "cross-site" }), context());
    expect(blocked.status).toBe(403);
    const origin = await DELETE(
      new NextRequest(url("?messageId=a"), { method: "DELETE", headers: { origin: "https://evil.example" } }),
      context(),
    );
    expect(origin.status).toBe(403);
    expect(await (await GET(new NextRequest(url()), context())).json()).toEqual({ bookmarks: [] });
  });

  it("prunes bookmarks of tasks that no longer exist when one is added", async () => {
    const other = "0f0f0f0f-aaaa-bbbb-cccc-000000000002";
    mocks.getTask.mockImplementation((id: string) => (id === TASK || id === other ? { id } : undefined));
    mocks.listTasks.mockReturnValue([{ id: TASK }, { id: other }]);
    await PUT(
      new NextRequest(`http://127.0.0.1:3010/api/tasks/${other}/bookmarks`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bookmark("x")),
      }),
      context(other),
    );
    mocks.listTasks.mockReturnValue([{ id: TASK }]);
    await PUT(put(bookmark("a")), context());
    mocks.getTask.mockImplementation((id: string) => ({ id }));
    expect((await (await GET(new NextRequest(url()), context(other))).json()).bookmarks).toEqual([]);
    expect((await (await GET(new NextRequest(url()), context())).json()).bookmarks).toHaveLength(1);
  });
});
