import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const store = vi.hoisted(() => ({ getTask: vi.fn(), getProject: vi.fn(), listProjects: vi.fn(() => []) }));
vi.mock("@/lib/store", () => store);
import { GET, HEAD } from "./route";
import { MAX_LOCAL_MEDIA_BYTES, openTaskLocalMedia, parseMediaRange, validateTaskLocalMedia } from "@/lib/local-media";

let root: string;
const mp4 = Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom"), 0, 0, 0, 0, ...Buffer.from("isom")]);
const wav = Buffer.from("RIFF0000WAVEfmt data PCM samples");
const params = () => ({ params: Promise.resolve({ id: "task" }) });
function request(path: string, range?: string, method = "GET") {
  return new NextRequest(`http://localhost/api/tasks/task/media?path=${encodeURIComponent(path)}`, {
    method, headers: range === undefined ? {} : { range },
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-media-"));
  store.getTask.mockReturnValue({ directory: root, projectId: null });
  store.getProject.mockReset();
  writeFileSync(join(root, "clip.mp4"), mp4);
  writeFileSync(join(root, "music.wav"), wav);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("task-local media", () => {
  it.each([
    ["clip.mp4", "video/mp4", mp4], ["clip.m4v", "video/mp4", mp4], ["clip.mov", "video/quicktime", mp4],
    ["music.m4a", "audio/mp4", mp4], ["music.wav", "audio/wav", wav],
    ["music.mp3", "audio/mpeg", Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00audio")],
    ["music.flac", "audio/flac", Buffer.from("fLaCaudio")],
    ["music.ogg", "audio/ogg", Buffer.from("OggS000OpusHead")],
    ["music.opus", "audio/ogg", Buffer.from("OggS000OpusHead")],
    ["music.aac", "audio/aac", Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0])],
    ["clip.webm", "video/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...Buffer.from("webm")])],
    ["music.weba", "audio/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...Buffer.from("webm")])],
  ])("streams verified %s with its declared MIME", async (path, mime, bytes) => {
    writeFileSync(join(root, path), bytes);
    const response = await GET(request(path), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each(["bytes=3-7", "bytes=3-", "bytes=-5", "bytes=0-9999", "bytes=-9999"])("serves bounded %s for seeking", async (range) => {
    const bounds = parseMediaRange(range, mp4.length)!;
    const response = await GET(request("clip.mp4", range), params());
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${bounds.start}-${bounds.end}/${mp4.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mp4.subarray(bounds.start, bounds.end + 1));
  });
  it.each(["bytes=99999-", "bytes=5-3", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "items=0-1", "bytes=9007199254740992-"])("rejects invalid range %s", async (range) => {
    const response = await GET(request("clip.mp4", range), params());
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${mp4.length}`);
  });
  it("HEAD closes its descriptor without streaming a body", async () => {
    const response = await HEAD(request("music.wav", "bytes=3-7", "HEAD"), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(wav.length));
    expect(await response.text()).toBe("");
  });
  it("does not fulfill If-Range without a matching representation validator", async () => {
    const req = request("clip.mp4", "bytes=3-7");
    req.headers.set("if-range", '"unknown"');
    const response = await GET(req, params());
    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mp4);
  });
  it("rejects unsupported extensions, misleading signatures, paths, and unknown tasks", async () => {
    writeFileSync(join(root, "fake.mp4"), "<html>not media</html>");
    writeFileSync(join(root, "fake.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("matroska")]));
    writeFileSync(join(root, "fake.ogg"), "OggS000theora");
    writeFileSync(join(root, "file.svg"), "<svg/>");
    writeFileSync(join(root, "fake.mp3"), "ID3");
    for (const path of ["fake.mp4", "fake.webm", "fake.ogg", "file.svg", "fake.mp3"]) {
      expect((await GET(request(path), params())).status).toBe(415);
    }
    for (const path of ["", "\\\\server\\share\\clip.mp4", "C:clip.mp4", "file:///tmp/clip.mp4", "https://example.com/clip.mp4", "bad\0.mp4"]) {
      expect((await GET(request(path), params())).status).toBe(400);
    }
    expect((await GET(request("/etc/passwd.mp4"), params())).status).toBe(403);
    store.getTask.mockReturnValueOnce(undefined);
    expect((await GET(request("clip.mp4"), params())).status).toBe(404);
  });
  it("rejects directories, empty files and oversized files before reading media", async () => {
    mkdirSync(join(root, "folder.mp4"));
    writeFileSync(join(root, "empty.mp4"), "");
    for (const path of ["folder.mp4", "empty.mp4"]) expect((await GET(request(path), params())).status).toBe(400);
    const large = join(root, "large.mp4");
    writeFileSync(large, mp4);
    truncateSync(large, MAX_LOCAL_MEDIA_BYTES + 1);
    expect((await GET(request("large.mp4"), params())).status).toBe(413);
  });
  it("separates video and audio validation and does not allocate the entire payload", async () => {
    expect(await validateTaskLocalMedia("task", "clip.mp4", "video")).toEqual({ ok: true });
    expect(await validateTaskLocalMedia("task", "music.wav", "audio")).toEqual({ ok: true });
    expect(await validateTaskLocalMedia("task", "music.wav", "video")).toMatchObject({ ok: false });
    truncateSync(join(root, "clip.mp4"), MAX_LOCAL_MEDIA_BYTES);
    const opened = await openTaskLocalMedia("task", "clip.mp4");
    expect(opened).toMatchObject({ ok: true, size: MAX_LOCAL_MEDIA_BYTES });
    if (opened.ok) await opened.file.close();
  });
  it("cancels a streaming response without leaving a descriptor in use", async () => {
    truncateSync(join(root, "clip.mp4"), 1024 * 1024);
    const response = await GET(request("clip.mp4"), params());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(await reader.read()).toMatchObject({ done: true });
  });
});
