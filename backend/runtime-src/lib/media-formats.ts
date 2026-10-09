/** Shared browser/server allowlist. Container support does not imply codec support in every browser. */
export type MediaKind = "video" | "audio";
export type MediaFormat = { kind: MediaKind; mime: string; signature: "mp4" | "webm" | "mp3" | "wav" | "ogg" | "flac" | "aac" };
const FORMATS: Readonly<Record<string, MediaFormat>> = {
  mp4: { kind: "video", mime: "video/mp4", signature: "mp4" },
  m4v: { kind: "video", mime: "video/mp4", signature: "mp4" },
  mov: { kind: "video", mime: "video/quicktime", signature: "mp4" },
  webm: { kind: "video", mime: "video/webm", signature: "webm" },
  mp3: { kind: "audio", mime: "audio/mpeg", signature: "mp3" },
  wav: { kind: "audio", mime: "audio/wav", signature: "wav" },
  m4a: { kind: "audio", mime: "audio/mp4", signature: "mp4" },
  aac: { kind: "audio", mime: "audio/aac", signature: "aac" },
  ogg: { kind: "audio", mime: "audio/ogg", signature: "ogg" },
  opus: { kind: "audio", mime: "audio/ogg", signature: "ogg" },
  flac: { kind: "audio", mime: "audio/flac", signature: "flac" },
  weba: { kind: "audio", mime: "audio/webm", signature: "webm" },
};
export function mediaFormatForPath(path: string): MediaFormat | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(FORMATS, extension) ? FORMATS[extension] : undefined;
}
