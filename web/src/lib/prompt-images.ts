export type PromptImageInput = {
  mimeType: string;
  data: string;
};

export function isPromptImage(value: unknown): value is PromptImageInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  return (
    typeof image.mimeType === "string" &&
    image.mimeType.length > 0 &&
    typeof image.data === "string" &&
    image.data.length > 0
  );
}

export function isPromptImageList(value: unknown): value is PromptImageInput[] {
  return Array.isArray(value) && value.every(isPromptImage);
}
