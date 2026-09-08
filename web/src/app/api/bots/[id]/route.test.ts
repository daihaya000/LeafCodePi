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
import * as harness from "../../../../lib/pi/harness";
import { createBot } from "../../../../lib/bots";
import { DELETE, GET, PATCH } from "./route";

describe("PATCH /api/bots/[id]", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-bot-patch-")); state.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); state.root = ""; });
  it("tears down the 1:1 task before deleting the bot", async () => {
    const bot = createBot({ name: "Delete bot" });
    const destroyTask = vi.spyOn(harness, "destroyTask");
    const response = await DELETE(new NextRequest("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: bot.id }) });
    expect(response.status).toBe(200);
    expect(destroyTask).toHaveBeenCalledWith(`bot:${bot.id}`);
    destroyTask.mockRestore();
  });

  it("validates and persists avatar colors", async () => {
    const bot = createBot({ name: "Patch bot" });
    const invalid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarColor: "blue" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(invalid.status).toBe(400);
    const valid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarColor: "#ABCDEF" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(valid.status).toBe(200);
    expect((await valid.json()).bot.avatarColor).toBe("#ABCDEF");
  });
  it("validates shapes and persists a complete avatar selection atomically", async () => {
    const bot = createBot({ name: "Shape bot" });
    const params = Promise.resolve({ id: bot.id });
    for (const avatarShape of ["unknown", "__proto__", "toString", null, 1, {}]) {
      const invalid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ avatarShape, avatarColor: "#112233" }) }), { params });
      expect(invalid.status).toBe(400);
    }
    const before = await GET(new NextRequest("http://localhost"), { params });
    expect((await before.json()).bot.avatarColor).toBe(bot.avatarColor);
    const avatar = { avatarShape: "cloud", avatarColor: "#ABCDEF", avatarImage: null };
    const valid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify(avatar) }), { params });
    expect(valid.status).toBe(200);
    expect((await valid.json()).bot).toMatchObject(avatar);
    const reloaded = await GET(new NextRequest("http://localhost"), { params });
    expect((await reloaded.json()).bot).toMatchObject(avatar);
  });
  it("validates and persists eye color and accessories, clearing the eye color with null", async () => {
    const bot = createBot({ name: "Face bot" });
    const params = Promise.resolve({ id: bot.id });
    const patch = (body: object) => PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify(body) }), { params });
    for (const body of [{ avatarEyeColor: "red" }, { avatarEyeColor: "#EF4444" }, { avatarEyeColor: "#111111" }, { avatarEyeColor: 1 }, { avatarGlasses: "yes" }, { avatarMustache: 1 }]) {
      expect((await patch(body)).status).toBe(400);
    }
    const face = { avatarEyeColor: "#FFFFFF", avatarGlasses: true, avatarMustache: true };
    expect((await (await patch(face)).json()).bot).toMatchObject(face);
    expect((await (await GET(new NextRequest("http://localhost"), { params })).json()).bot).toMatchObject(face);
    expect((await (await patch({ avatarEyeColor: "#000000" })).json()).bot.avatarEyeColor).toBe("#000000");
    const cleared = await (await patch({ avatarEyeColor: null, avatarGlasses: false })).json();
    expect(cleared.bot.avatarEyeColor).toBeUndefined();
    expect(cleared.bot).toMatchObject({ avatarGlasses: false, avatarMustache: true });
  });
  it("persists name and label through PATCH and GET reload", async () => {
    const bot = createBot({ name: "Profile bot" });
    const updated = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ name: "Renamed bot", label: "調査アシスタント" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(updated.status).toBe(200);
    const reloaded = await GET(new NextRequest("http://localhost"), { params: Promise.resolve({ id: bot.id }) });
    expect((await reloaded.json()).bot).toMatchObject({ name: "Renamed bot", label: "調査アシスタント" });
  });
  it("persists the enabled flag through PATCH and GET", async () => {
    const bot = createBot({ name: "Enabled patch bot" });
    const updated = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ enabled: false }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(updated.status).toBe(200);
    expect((await updated.json()).bot.enabled).toBe(false);
    const reloaded = await GET(new NextRequest("http://localhost"), { params: Promise.resolve({ id: bot.id }) });
    expect((await reloaded.json()).bot.enabled).toBe(false);
    const invalid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ enabled: "no" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(invalid.status).toBe(400);
  });

  it("persists notification preferences through PATCH and GET", async () => {
    const bot = createBot({ name: "Notify patch bot" });
    const updated = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ notificationsEnabled: false }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(updated.status).toBe(200);
    expect((await updated.json()).bot.notificationsEnabled).toBe(false);
    const reloaded = await GET(new NextRequest("http://localhost"), { params: Promise.resolve({ id: bot.id }) });
    expect((await reloaded.json()).bot.notificationsEnabled).toBe(false);
    const invalid = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ notificationsEnabled: "no" }) }), { params: Promise.resolve({ id: bot.id }) });
    expect(invalid.status).toBe(400);
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
