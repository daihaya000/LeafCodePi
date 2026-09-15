import { MAX_PROMPT_IMAGES, type PromptImageInput } from "@/lib/prompt-images";

/**
 * Bot→Code image forwarding policy (keep this comment in sync with MEMORY.md):
 *
 * 1. Explicit `images` on code_session (1-based indexes into this conversation's
 *    user-uploaded catalog, oldest-first): honor that exact list. `[]` attaches none.
 * 2. Omitted `images`: attach only images from the latest user message (capped at
 *    MAX_PROMPT_IMAGES). Older conversation images are not dumped unless selected.
 * 3. Goal-loop starts use the same image selection and attach images to their
 *    first turn only.
 *
 * Catalog scope: 1:1 Bot = the current session branch. Room = the current user
 * request only (a new user message is a new conversation).
 */
export type ConversationUserImage = PromptImageInput & {
  /** True when this image belongs to the latest user message in the catalog scope. */
  latestUser: boolean;
};

export type AvailableImageInfo = {
  index: number;
  mimeType: string;
  latestUser: boolean;
};

export function availableImageInfo(catalog: readonly ConversationUserImage[]): AvailableImageInfo[] {
  return catalog.map((image, index) => ({
    index: index + 1,
    mimeType: image.mimeType,
    latestUser: image.latestUser,
  }));
}

/** Typebox/JSON tool args may arrive as numbers or numeric strings. */
export function parseCodeSessionImageIndexes(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("images must be an array of 1-based indexes");
  if (value.length > MAX_PROMPT_IMAGES) throw new Error(`images is limited to ${MAX_PROMPT_IMAGES} items`);
  return value.map((item) => {
    const index = typeof item === "number" ? item : typeof item === "string" && /^\d+$/.test(item) ? Number(item) : Number.NaN;
    if (!Number.isInteger(index) || index < 1) throw new Error("images must be 1-based integer indexes");
    return index;
  });
}

export function resolveBotCodeImages(input: {
  catalog: readonly ConversationUserImage[];
  selected?: number[];
}): { images?: PromptImageInput[]; availableImages: AvailableImageInfo[]; attachedIndexes: number[] } {
  const availableImages = availableImageInfo(input.catalog);
  if (input.selected) {
    const images = input.selected.map((index) => {
      const image = input.catalog[index - 1];
      if (!image) throw new Error(`Unknown image index ${index}. Use code_session projects or status to list availableImages.`);
      return { mimeType: image.mimeType, data: image.data };
    });
    return {
      ...(images.length ? { images } : {}),
      availableImages,
      attachedIndexes: images.length ? input.selected : [],
    };
  }
  const attached: { image: PromptImageInput; index: number }[] = [];
  input.catalog.forEach((image, position) => {
    if (!image.latestUser || attached.length >= MAX_PROMPT_IMAGES) return;
    attached.push({ image: { mimeType: image.mimeType, data: image.data }, index: position + 1 });
  });
  return {
    ...(attached.length ? { images: attached.map((item) => item.image) } : {}),
    availableImages,
    attachedIndexes: attached.map((item) => item.index),
  };
}

function messageFromEntry(entry: unknown): { role?: string; content?: unknown } | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as { type?: unknown; message?: unknown; role?: unknown; content?: unknown };
  if (record.message && typeof record.message === "object" && !Array.isArray(record.message)) {
    return record.message as { role?: string; content?: unknown };
  }
  if (typeof record.role === "string") return { role: record.role, content: record.content };
  return undefined;
}

function promptImagesFromContent(content: unknown): PromptImageInput[] {
  if (!Array.isArray(content)) return [];
  const images: PromptImageInput[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as { type?: unknown; mimeType?: unknown; data?: unknown };
    if (record.type !== "image" || typeof record.data !== "string" || !record.data) continue;
    images.push({
      mimeType: typeof record.mimeType === "string" && record.mimeType ? record.mimeType : "image/png",
      data: record.data,
    });
  }
  return images;
}

/** 1:1 Bot catalog: every user-uploaded image on the current session branch, oldest-first. */
export function catalogFromSessionEntries(entries: readonly unknown[]): ConversationUserImage[] {
  const turns: { images: PromptImageInput[] }[] = [];
  for (const entry of entries) {
    const message = messageFromEntry(entry);
    if (message?.role !== "user") continue;
    turns.push({ images: promptImagesFromContent(message.content) });
  }
  const last = turns.length - 1;
  return turns.flatMap((turn, turnIndex) =>
    turn.images.map((image) => ({ ...image, latestUser: turnIndex === last })),
  );
}

/** Room catalog: images on the current user request only (a new user message is a new conversation). */
export function catalogFromRoomUserRequest(
  messages: readonly { id: string; role: string }[],
  load: (messageId: string) => PromptImageInput[],
): ConversationUserImage[] {
  const latestId = [...messages].reverse().find((message) => message.role === "user")?.id;
  if (!latestId) return [];
  return load(latestId).map((image) => ({ ...image, latestUser: true }));
}
