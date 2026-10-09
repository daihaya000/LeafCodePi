import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { randomBytes } from "node:crypto";
import { Parser } from "htmlparser2";
import { isSensitivePreviewUrl, linkPreviewKey, normalizeLinkUrl, type LinkPreview } from "@/lib/link-preview-shared";
import { fetchPublicWebBytes } from "@/lib/public-web-fetch";
import { imageMimeFromBytes } from "@/lib/raster-image";

const PAGE_TTL = 5 * 60_000;
const IMAGE_TTL = 10 * 60_000;
const MAX_ENTRIES = 128;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_IMAGE_BYTES = 8 * 1024 * 1024;
type ImageData = { bytes: Buffer; mime: string };
type Thumbnail = { url: string; expires: number; data?: ImageData; pending?: Promise<ImageData | null> };
type PreviewState = {
  pages: Map<string, { value: LinkPreview; expires: number }>;
  pending: Map<string, Promise<LinkPreview>>;
  images: Map<string, Thumbnail>;
  activeImages: number;
  cachedImageBytes: number;
};
const globalCache = globalThis as typeof globalThis & { __leafcodeLinkPreviews?: PreviewState };
function previewState(): PreviewState {
  assertConfigurationOwner();
  const state = globalCache.__leafcodeLinkPreviews ??= { pages: new Map(), pending: new Map(), images: new Map(), activeImages: 0, cachedImageBytes: 0 };
// Compatible with the existing hot-reload cache (which held only URLs and pending requests).
state.cachedImageBytes ??= 0;
  return state;
}
function discardImage(id: string) {
  const image = previewState().images.get(id);
  if (image?.data) previewState().cachedImageBytes -= image.data.bytes.length;
  previewState().images.delete(id);
}
function pruneImages() {
  for (const [id, image] of previewState().images) if (image.expires <= Date.now()) discardImage(id);
  while (previewState().images.size > MAX_ENTRIES) discardImage(previewState().images.keys().next().value!);
}
function cacheImage(image: Thumbnail, data: ImageData) {
  for (const older of previewState().images.values()) {
    if (previewState().cachedImageBytes + data.bytes.length <= MAX_CACHED_IMAGE_BYTES) break;
    if (older.data) { previewState().cachedImageBytes -= older.data.bytes.length; delete older.data; }
  }
  image.data = data;
  previewState().cachedImageBytes += data.bytes.length;
}
function prune<T extends { expires: number }>(map: Map<string, T>, limit = MAX_ENTRIES) {
  for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  while (map.size > limit) map.delete(map.keys().next().value!);
}
const clean = (value: string, limit: number) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

export function parseLinkMetadata(html: string, baseUrl: string): Omit<LinkPreview, "url" | "image"> & { imageUrl?: string } {
  const metadata = new Map<string, string>();
  let inTitle = false;
  let title = "";
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "body") { parser.pause(); return; }
      if (name === "title") inTitle = true;
      if (name !== "meta") return;
      const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
      if (/^(?:og:(?:title|description|image|site_name)|twitter:(?:title|description|image)|description)$/.test(key) && attributes.content && !metadata.has(key)) {
        const content = key.endsWith(":image") ? attributes.content.trim().slice(0, 8192) : clean(attributes.content, 8192);
        if (content) metadata.set(key, content);
      }
    },
    ontext(text) { if (inTitle && title.length < 4096) title += text.slice(0, 4096 - title.length); },
    onclosetag(name) {
      if (name === "title") inTitle = false;
      if (name === "head") parser.pause();
    },
  }, { decodeEntities: true });
  parser.end(html);
  const result: Omit<LinkPreview, "url" | "image"> & { imageUrl?: string } = {
    title: clean(metadata.get("og:title") ?? metadata.get("twitter:title") ?? title, 200) || new URL(baseUrl).hostname,
    description: clean(metadata.get("og:description") ?? metadata.get("twitter:description") ?? metadata.get("description") ?? "", 400),
    siteName: clean(metadata.get("og:site_name") ?? "", 80),
  };
  const image = metadata.get("og:image") ?? metadata.get("twitter:image");
  if (image) {
    try { result.imageUrl = normalizeLinkUrl(new URL(image, baseUrl).href) ?? undefined; } catch { /* No image. */ }
  }
  return result;
}

export async function getLinkPreview(value: string): Promise<LinkPreview> {
  assertConfigurationOwner();
  const normalized = normalizeLinkUrl(value);
  if (!normalized) throw new Error("Invalid URL");
  const url = linkPreviewKey(normalized);
  const hostname = new URL(url).hostname;
  const fallback: LinkPreview = { url, title: hostname, siteName: hostname };
  // Check provenance before sharing a fragment-free cached document.
  if (isSensitivePreviewUrl(normalized)) return fallback;
  prune(previewState().pages);
  pruneImages();
  const cached = previewState().pages.get(url);
  if (cached) return cached.value;
  const inflight = previewState().pending.get(url);
  if (inflight) return inflight;
  if (previewState().pending.size >= 8) return fallback;
  const work = (async () => {
    let result = fallback;
    let resolved = false;
    try {
      const page = await fetchPublicWebBytes(url, { accept: "text/html,application/xhtml+xml", maxBytes: 256 * 1024, prefix: true, noSensitiveLinks: true });
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(page.contentType)) throw new Error("Not HTML");
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(page.contentType)?.[1]
        ?? /<meta[^>]+charset\s*=\s*["']?([^\s>"']+)/i.exec(page.bytes.subarray(0, 2048).toString("ascii"))?.[1];
      let html: string;
      try { html = new TextDecoder(charset ?? "utf-8").decode(page.bytes); }
      catch { html = page.bytes.toString("utf8"); }
      const { imageUrl, ...metadata } = parseLinkMetadata(html, page.url);
      result = { url, ...metadata };
      if (imageUrl) {
        const id = randomBytes(16).toString("hex");
        previewState().images.set(id, { url: imageUrl, expires: Date.now() + IMAGE_TTL });
        result.image = `/api/link-preview/image?id=${id}`;
        pruneImages();
      }
      resolved = true;
    } catch { /* Private, unavailable and sign-in-only pages still yield a clickable card. No URL logging. */ }
    previewState().pages.set(url, { value: result, expires: Date.now() + (resolved ? PAGE_TTL : 30_000) });
    prune(previewState().pages);
    return result;
  })();
  previewState().pending.set(url, work);
  try { return await work; } finally { previewState().pending.delete(url); }
}

/** Opaque IDs only: the browser cannot turn this endpoint into an arbitrary remote-image proxy. */
export async function getLinkPreviewImage(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  assertConfigurationOwner();
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  pruneImages();
  const image = previewState().images.get(id);
  if (!image) return null;
  if (image.data) {
    previewState().images.delete(id);
    previewState().images.set(id, image);
    return image.data;
  }
  if (image.pending) return image.pending.catch(() => null);
  if (previewState().activeImages >= 8) return null;
  previewState().activeImages++;
  const work = (async () => {
    const result = await fetchPublicWebBytes(image.url, {
      accept: "image/avif,image/webp,image/*", maxBytes: MAX_IMAGE_BYTES,
      noSensitiveLinks: true, allowImageSignatures: true,
    });
    const mime = imageMimeFromBytes(result.bytes);
    if (!mime) throw new Error("Unsupported thumbnail");
    const data = { bytes: result.bytes, mime };
    if (previewState().images.get(id) === image) cacheImage(image, data);
    return data;
  })().catch(() => { if (previewState().images.get(id) === image) discardImage(id); return null; })
    .finally(() => { previewState().activeImages--; delete image.pending; });
  image.pending = work;
  return work;
}
