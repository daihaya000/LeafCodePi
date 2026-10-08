/** Shared between native reply deduplication and the browser; never fetches a source. */
export type MarkdownMediaSource =
  | { kind: "local"; path: string }
  | { kind: "remote"; url: string; host: string }
  | { kind: "invalid"; label: string };
export function decodeMediaPath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
function local(path: string): MarkdownMediaSource {
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)) {
    return { kind: "invalid", label: "表示できないメディアパス" };
  }
  return { kind: "local", path };
}
export function classifyMarkdownMediaSource(value: string): MarkdownMediaSource {
  // A permitted 4096-character path can become much longer when percent-encoded.
  if (!value || value.length > 4096 * 12 + 16) return { kind: "invalid", label: "表示できないメディアパス" };
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (value.length > 8192 || !url.hostname || url.username || url.password) return { kind: "invalid", label: "表示できない外部URL" };
      return { kind: "remote", url: value, host: url.host };
    } catch { return { kind: "invalid", label: "表示できない外部URL" }; }
  }
  // Parse the original URL, then decode its pathname exactly once (literal %20 is not a space).
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return { kind: "invalid", label: "ネットワーク上のメディアは表示できません" };
      let path = decodeMediaPath(url.pathname);
      if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
      return local(path);
    } catch { return { kind: "invalid", label: "表示できないファイルURL" }; }
  }
  const decoded = decodeMediaPath(value);
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(decoded) && !/^[A-Za-z]:[\\/]/.test(decoded)) {
    return { kind: "invalid", label: "このURL形式のメディアは表示できません" };
  }
  return local(decoded);
}
export function localMediaPathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}
