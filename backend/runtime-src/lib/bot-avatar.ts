// Compatibility entrypoint: the avatar vocabulary lives in backend core so the
// Backend process can validate persisted bot config without importing the Web app.
export {
  AVATAR_IMAGE_ACCEPT,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  MAX_AVATAR_IMAGE_BYTES,
  autoEyeColor,
  avatarColorForId,
  isAvatarColor,
  isAvatarEyeColor,
  isAvatarImage,
  isAvatarShape,
  randomAvatarColor,
  type BotAvatarColor,
  type BotAvatarShape,
} from "@backend-core/bot-avatar.mjs";
