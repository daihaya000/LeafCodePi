export type PromptImageInput = {
  mimeType: string;
  data: string;
};

/** Non-image files are sent as UTF-8 text because Pi's prompt API accepts images only. */
export type PromptFileInput = {
  name: string;
  mimeType: string;
  data: string;
};

const PROMPT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_PROMPT_ATTACHMENTS = 8;
export const MAX_PROMPT_IMAGES = MAX_PROMPT_ATTACHMENTS;
export const MAX_PROMPT_FILES = MAX_PROMPT_ATTACHMENTS;
export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PROMPT_FILE_BYTES = MAX_PROMPT_IMAGE_BYTES;
export const MAX_PROMPT_FILE_NAME_CHARS = 255;

function hasSafeFileMetadata(name: unknown, mimeType: unknown): boolean {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    Array.from(name).length <= MAX_PROMPT_FILE_NAME_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    typeof mimeType === "string" &&
    mimeType.length > 0 &&
    mimeType.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(mimeType)
  );
}

export function isPromptImage(value: unknown): value is PromptImageInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  return (
    typeof image.mimeType === "string" &&
    PROMPT_IMAGE_MIME_TYPES.has(image.mimeType.toLowerCase()) &&
    typeof image.data === "string" &&
    image.data.length > 0
  );
}

export function isPromptImageList(value: unknown): value is PromptImageInput[] {
  return Array.isArray(value) && value.length <= MAX_PROMPT_IMAGES && value.every(isPromptImage);
}

export function isPromptImageWithinSize(image: PromptImageInput): boolean {
  const bytes = Buffer.byteLength(image.data, "base64");
  if (bytes === 0 || bytes > MAX_PROMPT_IMAGE_BYTES) return false;
  const canonical = Buffer.from(image.data, "base64").toString("base64");
  return image.data === canonical || image.data === canonical.replace(/=+$/, "");
}

export function isPromptFile(value: unknown): value is PromptFileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return hasSafeFileMetadata(file.name, file.mimeType) && typeof file.data === "string" && file.data.length > 0;
}

export function isPromptFileList(value: unknown): value is PromptFileInput[] {
  return Array.isArray(value) && value.length <= MAX_PROMPT_FILES && value.every(isPromptFile);
}

export function isPromptFileWithinSize(file: PromptFileInput): boolean {
  const bytes = Buffer.byteLength(file.data, "base64");
  if (bytes === 0 || bytes > MAX_PROMPT_FILE_BYTES) return false;
  const canonical = Buffer.from(file.data, "base64").toString("base64");
  return file.data === canonical || file.data === canonical.replace(/=+$/, "");
}

/** Decode an uploaded file without silently replacing binary bytes. */
export function decodePromptFile(file: PromptFileInput): string | null {
  if (!isPromptFileWithinSize(file)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.data, "base64"));
  } catch {
    return null;
  }
}

export function isPromptFileText(file: PromptFileInput): boolean {
  return decodePromptFile(file) !== null;
}

/** Keep file contents readable to the model while making them removable from UI history. */
export function formatPromptWithFiles(prompt: string, files: PromptFileInput[]): string {
  if (files.length === 0) return prompt;
  const markers = files.map((file) => {
    const content = decodePromptFile(file);
    if (content === null) throw new Error("添付ファイルはUTF-8テキストのみ対応しています");
    const payload = JSON.stringify({ name: file.name, mimeType: file.mimeType, content }).replaceAll("<", "\\u003c");
    return `<leafcode-file>\n${payload}\n</leafcode-file>`;
  });
  return [prompt, ...markers].filter((part) => part.length > 0).join("\n\n");
}

/** Hide the transport marker from the timeline and recover a file payload for revert/resume. */
export function parsePromptFileMarkers(value: string): { text: string; files: PromptFileInput[] } {
  const files: PromptFileInput[] = [];
  const marker = /(?:^|\n\n)<leafcode-file>\r?\n([\s\S]*?)\r?\n<\/leafcode-file>/g;
  let text = "";
  let cursor = 0;
  for (const match of value.matchAll(marker)) {
    const full = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + full.length;
    text += value.slice(cursor, start);
    try {
      const payload = JSON.parse(match[1] ?? "") as { name?: unknown; mimeType?: unknown; content?: unknown };
      if (
        typeof payload.content !== "string" ||
        !hasSafeFileMetadata(payload.name, payload.mimeType)
      ) throw new Error("invalid marker");
      const file = {
        name: payload.name as string,
        mimeType: payload.mimeType as string,
        data: Buffer.from(payload.content, "utf8").toString("base64"),
      };
      if (!isPromptFile(file)) throw new Error("invalid marker");
      files.push(file);
    } catch {
      text += value.slice(start, end);
    }
    cursor = end;
  }
  text += value.slice(cursor);
  return { text, files };
}
