import { beforeEach, expect, it, vi } from "vitest";
const remote = vi.hoisted(() => vi.fn());
vi.mock("./public-web-fetch", () => ({ fetchPublicWebBytes: remote }));
import { getLinkPreview, getLinkPreviewImage, parseLinkMetadata } from "./link-preview";
beforeEach(() => {
  remote.mockReset();
  const cache = (globalThis as unknown as { __leafcodeLinkPreviews: { pages: Map<string, unknown>; pending: Map<string, unknown>; images: Map<string, unknown>; activeImages: number } }).__leafcodeLinkPreviews;
  cache.pages.clear(); cache.pending.clear(); cache.images.clear(); cache.activeImages = 0;
});
it("parses Open Graph/entity attributes, relative thumbnails and Unicode without executing HTML", () => {
  const value = parseLinkMetadata(`<head><title>fallback</title><meta content='木村 &amp; そうめん' property='og:title'><meta name="description" content="fallback description"><meta property="og:description" content="説明 &quot;引用&quot;"><meta property="og:site_name" content="YouTube"><meta property="og:image" content="/preview.jpg?x=1&amp;y=2"><script>const x='<meta property="og:title" content="wrong">'</script></head>`, "https://www.youtube.com/shorts/example");
  expect(value).toEqual({ title: "木村 & そうめん", description: '説明 "引用"', siteName: "YouTube", imageUrl: "https://www.youtube.com/preview.jpg?x=1&y=2" });
});
it("falls back to Twitter/title metadata and refuses unsafe image schemes", () => {
  expect(parseLinkMetadata('<title>Public Notion &amp; notes</title><meta name="twitter:description" content="Shared page"><meta property="og:image" content="javascript:alert(1)">', "https://example.notion.site/page")).toEqual({ title: "Public Notion & notes", description: "Shared page", siteName: "", imageUrl: undefined });
});
it("deduplicates concurrent page fetches and caches previews without exposing thumbnail source URLs", async () => {
  remote.mockResolvedValue({ bytes: Buffer.from('<title>Document</title><meta property="og:image" content="https://cdn.example.com/secret.jpg?signature=private">'), contentType: "text/html", url: "https://example.notion.site/page" });
  const [first, second] = await Promise.all([getLinkPreview("https://example.notion.site/page#a"), getLinkPreview("https://example.notion.site/page#b")]);
  expect(first).toEqual(second);
  expect(first.image).toMatch(/^\/api\/link-preview\/image\?id=[a-f0-9]{32}$/);
  expect(JSON.stringify(first)).not.toContain("signature");
  await getLinkPreview("https://example.notion.site/page");
  expect(remote).toHaveBeenCalledOnce();
});
it("keeps blocked, private Notion and non-HTML pages as clickable hostname cards", async () => {
  remote.mockRejectedValueOnce(new Error("private"));
  expect(await getLinkPreview("https://www.notion.so/private")).toEqual({ url: "https://www.notion.so/private", title: "www.notion.so", siteName: "www.notion.so" });
  remote.mockResolvedValueOnce({ bytes: Buffer.from("{}"), contentType: "application/json", url: "https://example.com/json" });
  expect((await getLinkPreview("https://example.com/json")).image).toBeUndefined();
});
it("does not consume login, invitation or query-token links for metadata", async () => {
  for (const url of ["https://example.com/login", "https://example.com/invite/one-time", "https://example.com/page?token=private", "https://example.com/page#access_token=private"]) {
    expect((await getLinkPreview(url)).title).toBe("example.com");
  }
  expect(remote).not.toHaveBeenCalled();
});
it("decodes declared Japanese legacy encodings", async () => {
  remote.mockResolvedValue({ bytes: Buffer.concat([Buffer.from("<title>"), Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]), Buffer.from("</title>")]), contentType: "text/html; charset=shift_jis", url: "https://example.com/" });
  expect((await getLinkPreview("https://example.com/")).title).toBe("テスト");
});
it("serves only previously registered raster thumbnails and rejects SVG or arbitrary proxy URLs", async () => {
  expect(await getLinkPreviewImage("https://example.com/image")).toBeNull();
  expect(await getLinkPreviewImage("a".repeat(32))).toBeNull();
  expect(remote).not.toHaveBeenCalled();
  remote.mockResolvedValueOnce({ bytes: Buffer.from('<title>Page</title><meta property="og:image" content="/thumb.png">'), contentType: "text/html", url: "https://example.com/page" });
  const preview = await getLinkPreview("https://example.com/page");
  const id = new URL(preview.image!, "http://localhost").searchParams.get("id")!;
  remote.mockResolvedValueOnce({ bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"), contentType: "image/png", url: "https://example.com/thumb.png" });
  expect(await getLinkPreviewImage(id)).toMatchObject({ mime: "image/png" });
  expect(remote).toHaveBeenLastCalledWith("https://example.com/thumb.png", expect.objectContaining({ maxBytes: 2 * 1024 * 1024 }));
  remote.mockResolvedValueOnce({ bytes: Buffer.from("<svg><script/></svg>"), contentType: "image/svg+xml", url: "https://example.com/thumb.png" });
  expect(await getLinkPreviewImage(id)).toBeNull();
  expect(await getLinkPreviewImage(id)).toBeNull();
});
