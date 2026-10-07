export type LinkPreview = {
  url: string; title: string; description?: string; siteName?: string; image?: string;
};

/** Public URL syntax only; server-side DNS and transport validation are separate. */
export function normalizeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.port) return null;
    return url.href.length <= 8192 ? url.href : null;
  } catch { return null; }
}

/** Never consume one-time login/invite/reset links just to draw a preview. The link still opens on user click. */
export function isSensitivePreviewUrl(value: string): boolean {
  const url = new URL(value);
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Invalid escapes stay literal. */ }
  return /\/(?:auth|oauth|authorize|login|signin|sign-in|reset|recover|verify|reset-password|password-reset|password\/(?:reset|forgot)|invite|confirm-email)(?:\/|$)/i.test(path)
    || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1).split("?").at(-1)).keys()].some((key) =>
      /^(?:token|access_token|refresh_token|id_token|api[_-]?key|password|secret|code|sig|signature|auth|key|x-amz-.+)$/i.test(key),
    );
}

export type UrlAttachmentSegment = { text: string } | { url: string; label?: string };
/** URL-only lines become attachments. Prose, references and fenced code remain literal text. */
export function splitUrlAttachments(text: string, limit = 6): UrlAttachmentSegment[] {
  const segments: UrlAttachmentSegment[] = [];
  let pending = "";
  let fence: { character: string; length: number } | undefined;
  let count = 0;
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const insideFence = Boolean(fence);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (fence.character === marker[1][0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    }
    const standalone = line.trim();
    const labelled = /^\[([^\]\r\n]+)\]\(<?(https?:\/\/[^\s<>]+)>?\)$/.exec(standalone);
    const candidate = labelled?.[2] ?? standalone.replace(/^<(https?:\/\/[^<>]+)>$/, "$1");
    const url = !insideFence && !marker && !/^(?: {4}|\t)/.test(line) && count < limit ? normalizeLinkUrl(candidate) : null;
    if (url && !seen.has(url)) {
      if (pending) { segments.push({ text: pending }); pending = ""; }
      segments.push({ url, ...(labelled ? { label: labelled[1] } : {}) });
      seen.add(url);
      count++;
    } else pending += line + (index < lines.length - 1 ? "\n" : "");
  }
  if (pending) segments.push({ text: pending });
  return segments;
}
