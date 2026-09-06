export const BOT_AVATAR_COLORS = [
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#F97316",
  "#10B981",
  "#06B6D4",
  "#EAB308",
  "#EF4444",
] as const;

export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

export function isAvatarColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

export function avatarColorForId(id: string): BotAvatarColor {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return BOT_AVATAR_COLORS[hash % BOT_AVATAR_COLORS.length]!;
}

export function randomAvatarColor(exclude?: string): BotAvatarColor {
  const choices = exclude && BOT_AVATAR_COLORS.length > 1
    ? BOT_AVATAR_COLORS.filter((color) => color !== exclude)
    : BOT_AVATAR_COLORS;
  return choices[Math.floor(Math.random() * choices.length)]!;
}

// プロジェクトアイコン（/api/projects）と同じ制約で統一：2 MB相当のbase64長、png/jpeg/gif/webpのみ。
export const AVATAR_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const MAX_AVATAR_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_AVATAR_IMAGE_LENGTH = 3_000_000;
const AVATAR_IMAGE_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

export function isAvatarImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_AVATAR_IMAGE_LENGTH && AVATAR_IMAGE_PATTERN.test(value);
}
