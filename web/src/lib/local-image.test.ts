import { mkdtempSync, readSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ getTask: vi.fn(), getProject: vi.fn(), listProjects: vi.fn(() => []) }));
vi.mock("@/lib/store", () => store);
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { MAX_LOCAL_IMAGE_BYTES, readTaskLocalImage, validateTaskLocalImage } from "./local-image";
let root: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-image-header-"));
  store.getTask.mockReturnValue({ directory: root, projectId: null });
  writeFileSync(join(root, "image.png"), png);
  vi.mocked(readSync).mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("validates a maximum-size image with only a 32-byte read", () => {
  truncateSync(join(root, "image.png"), MAX_LOCAL_IMAGE_BYTES);
  expect(validateTaskLocalImage("task", "image.png")).toEqual({ ok: true });
  expect(readSync).toHaveBeenCalledOnce();
  expect(vi.mocked(readSync).mock.calls[0].slice(2)).toEqual([0, 32, 0]);
});
it("still serves the complete verified image from its bounded descriptor", () => {
  const image = readTaskLocalImage("task", "image.png");
  expect(image).toMatchObject({ ok: true, mime: "image/png" });
  if (image.ok) expect(image.bytes).toEqual(png);
  expect(readSync).toHaveBeenCalledTimes(2);
});
it("rejects a file that grows during delivery without reading its added payload", () => {
  const original = vi.mocked(readSync).getMockImplementation()!;
  vi.mocked(readSync).mockImplementation(((...args: unknown[]) => {
    const count = Reflect.apply(original, undefined, args) as number;
    if (typeof args[3] === "number" && args[3] > 32) truncateSync(join(root, "image.png"), MAX_LOCAL_IMAGE_BYTES + 1);
    return count;
  }) as typeof readSync);
  try {
    expect(readTaskLocalImage("task", "image.png")).toMatchObject({ ok: false, status: 413 });
    expect(vi.mocked(readSync).mock.calls.map((call) => Array.from(call)[3])).toEqual([32, png.length]);
  } finally { vi.mocked(readSync).mockImplementation(original); }
});

it("rejects oversized and misleading images in both registration and delivery", () => {
  writeFileSync(join(root, "fake.png"), "not an image");
  expect(validateTaskLocalImage("task", "fake.png")).toMatchObject({ ok: false, status: 415 });
  truncateSync(join(root, "image.png"), MAX_LOCAL_IMAGE_BYTES + 1);
  expect(validateTaskLocalImage("task", "image.png")).toMatchObject({ ok: false, status: 413 });
  expect(readTaskLocalImage("task", "image.png")).toMatchObject({ ok: false, status: 413 });
});
