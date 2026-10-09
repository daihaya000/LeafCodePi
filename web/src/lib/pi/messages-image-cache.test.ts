import { beforeEach, describe, expect, it } from "vitest";
import { projectPiMessages, readImageDataUrlCacheDiagnostics, resetImageDataUrlCacheForTests } from "./messages";

beforeEach(() => resetImageDataUrlCacheForTests());
function projectImage(data: string, mimeType = "image/png") {
  return projectPiMessages([{ role: "user", timestamp: 1, content: [{ type: "image", mimeType, data }] }]);
}
describe("image data URL cache budget", () => {
  it("bounds retained URLs and keys by bytes as well as entry count", () => {
    for (let at = 0; at < 16; at++) projectImage(String.fromCharCode(65 + at) + "A".repeat(256 * 1024));
    const cache = readImageDataUrlCacheDiagnostics();
    expect(cache.entries).toBeLessThanOrEqual(16);
    expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes);
    expect(cache.entries).toBeGreaterThan(0);
  });
  it("retains the 16-entry limit and does not double-charge cache hits", () => {
    for (let at = 0; at < 32; at++) projectImage(`image${at}`);
    const before = readImageDataUrlCacheDiagnostics();
    expect(before.entries).toBe(16);
    projectImage("image31");
    expect(readImageDataUrlCacheDiagnostics()).toEqual(before);
    resetImageDataUrlCacheForTests();
    expect(readImageDataUrlCacheDiagnostics()).toMatchObject({ entries: 0, bytes: 0 });
    projectImage("after-reset");
    expect(readImageDataUrlCacheDiagnostics().bytes).toBeGreaterThan(0);
  });
  it("an oversized image does not evict useful small cached images", () => {
    projectImage("small");
    const before = readImageDataUrlCacheDiagnostics();
    projectImage("A".repeat(4 * 1024 * 1024));
    expect(readImageDataUrlCacheDiagnostics()).toEqual(before);
  });
  it("does not retain an oversized image but preserves its exact data URL", () => {
    const data = "A".repeat(4 * 1024 * 1024);
    const messages = projectImage(data);
    expect(messages[0].parts[0].type).toBe("image");
    const image = messages[0].parts[0];
    if (image.type !== "image") throw new Error("Expected an image part");
    expect(image.url === `data:image/png;base64,${data}`).toBe(true);
    expect(readImageDataUrlCacheDiagnostics()).toMatchObject({ entries: 0, bytes: 0 });
  });
});
