import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../../lib/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/paths")>();
  return { ...actual, dataDir: () => state.root };
});
import { NextRequest } from "next/server";
import { createBot } from "../../../../lib/bots";
import { PATCH } from "./route";

describe("PATCH /api/bots/[id]", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-bot-patch-")); state.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); state.root = ""; });
  it("validates and persists avatar colors", async () => {
    const bot = createBot({ name: "Patch bot" });
    const invalid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarColor: "blue" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(invalid.status).toBe(400);
    const valid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarColor: "#ABCDEF" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(valid.status).toBe(200);
    expect((await valid.json()).bot.avatarColor).toBe("#ABCDEF");
  });
  it("validates, persists, and clears an avatar image", async () => {
    const bot = createBot({ name: "Image patch bot" });
    const invalid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarImage: "not-a-data-url" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(invalid.status).toBe(400);
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const valid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarImage: dataUrl }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(valid.status).toBe(200);
    expect((await valid.json()).bot.avatarImage).toBe(dataUrl);
    const cleared = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarImage: null }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).bot.avatarImage).toBeNull();
  });
});
