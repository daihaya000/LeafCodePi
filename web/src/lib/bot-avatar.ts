export const BOT_AVATAR_COLORS = [
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#F97316",
  "#10B981",
  "#06B6D4",
  "#EAB308",
  "#EF4444",
  "#111111",
  "#A67C52",
  "#14B8A6",
  "#949494",
] as const;

export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

export const BOT_AVATAR_SHAPES = [
  { id: "circle", label: "まる", path: "M50 0a50 50 0 1 0 0 100a50 50 0 1 0 0-100", eyeOffset: 0 },
  { id: "leaf", label: "葉っぱ", path: "M2 50C26-5 74-5 98 50C74 105 26 105 2 50Z", eyeOffset: 4 },
  { id: "oval", label: "たまご", path: "M48 6C74 0 97 28 96 55S74 96 46 93S2 71 5 45S23 12 48 6Z", eyeOffset: 4 },
  { id: "square", label: "角丸四角", path: "M25 5H75Q95 5 95 25V75Q95 95 75 95H25Q5 95 5 75V25Q5 5 25 5Z", eyeOffset: 4 },
  { id: "capsule", label: "カプセル", path: "M34 18H66a32 32 0 0 1 0 64H34a32 32 0 0 1 0-64Z", eyeOffset: 10 },
  { id: "triangle", label: "三角", path: "M40 10Q50-5 60 10L97 79Q105 95 86 95H14Q-5 95 3 79Z", eyeOffset: 22 },
  { id: "hexagon", label: "六角", path: "M43 3Q50-1 57 3L89 22Q96 26 96 34V66Q96 74 89 78L57 97Q50 101 43 97L11 78Q4 74 4 66V34Q4 26 11 22Z", eyeOffset: 8 },
  { id: "cloud", label: "くも", path: "M17 41C7 13 39-1 54 17C74 0 98 20 89 40C112 61 94 90 72 85C57 104 32 95 27 86C-2 96-10 54 17 41Z", eyeOffset: 14 },
  { id: "droplet", label: "しずく", path: "M44 4Q50-4 56 4C64 17 92 43 92 64a42 34 0 0 1-84 0C8 43 36 17 44 4Z", eyeOffset: 22 },
] as const;

export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number]["id"];

export function isAvatarShape(value: unknown): value is BotAvatarShape {
  return BOT_AVATAR_SHAPES.some((shape) => shape.id === value);
}

/** Default eye ink: white, darkened only on pale bodies where white eyes would disappear. */
export function autoEyeColor(color: string): string {
  if (!isAvatarColor(color)) return "#FFFFFF";
  const channels = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return 1.05 / (luminance + 0.05) >= 2 ? "#FFFFFF" : "#000000";
}

export function isAvatarEyeColor(value: unknown): value is string {
  return typeof value === "string" && /^(#FFFFFF|#000000)$/i.test(value);
}

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
