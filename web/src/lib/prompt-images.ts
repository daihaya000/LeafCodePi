export type PromptImageInput = {
  mimeType: string;
  data: string;
};

const PROMPT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_PROMPT_IMAGES = 8;

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
