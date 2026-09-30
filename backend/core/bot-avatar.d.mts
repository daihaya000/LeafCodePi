export const BOT_AVATAR_COLORS: [
  "#3B82F6", "#8B5CF6", "#EC4899", "#F97316", "#10B981", "#06B6D4",
  "#EAB308", "#EF4444", "#111111", "#A67C52", "#14B8A6", "#949494",
];
export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

export const BOT_AVATAR_SHAPES: [
  { id: "circle"; label: string; path: string; eyeOffset: number },
  { id: "leaf"; label: string; path: string; eyeOffset: number },
  { id: "oval"; label: string; path: string; eyeOffset: number },
  { id: "square"; label: string; path: string; eyeOffset: number },
  { id: "capsule"; label: string; path: string; eyeOffset: number },
  { id: "triangle"; label: string; path: string; eyeOffset: number },
  { id: "hexagon"; label: string; path: string; eyeOffset: number },
  { id: "cloud"; label: string; path: string; eyeOffset: number },
  { id: "droplet"; label: string; path: string; eyeOffset: number },
];
export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number]["id"];

export function isAvatarShape(value: unknown): value is BotAvatarShape;
export function autoEyeColor(color: string): string;
export function isAvatarEyeColor(value: unknown): value is string;
export function isAvatarColor(value: unknown): value is string;
export function avatarColorForId(id: string): BotAvatarColor;
export function randomAvatarColor(exclude?: string): BotAvatarColor;
export const AVATAR_IMAGE_ACCEPT: string;
export const MAX_AVATAR_IMAGE_BYTES: number;
export function isAvatarImage(value: unknown): value is string;
