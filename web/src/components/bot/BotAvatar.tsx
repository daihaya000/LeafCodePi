import { cx } from "@/components/ui";
import { autoEyeColor, BOT_AVATAR_SHAPES, isAvatarColor, type BotAvatarShape } from "@/lib/bot-avatar";

/** Prop names match BotDto so any bot-shaped object can be spread in directly. */
type BotAvatarProps = {
  size?: number;
  avatarColor?: string;
  avatarShape?: BotAvatarShape;
  /** 目の色。未設定なら本体色から自動（通常は白）。 */
  avatarEyeColor?: string | null;
  avatarGlasses?: boolean;
  avatarMustache?: boolean;
  /** アップロードされたアバター画像（data URL）。あれば幾何学顔アイコンより優先する。 */
  avatarImage?: string | null;
  name?: string;
  className?: string;
  /** Activity cue shared by generated faces and uploaded avatars. */
  active?: boolean;
};

/** The avatar-defining fields of a bot, so any surface can pass its bot object straight through. */
export type BotFace = Pick<BotAvatarProps, "avatarColor" | "avatarShape" | "avatarEyeColor" | "avatarGlasses" | "avatarMustache" | "avatarImage">;

/** Small geometric bot face used consistently throughout Bot mode; falls back from an uploaded image. */
export function BotAvatar({
  size = 32, avatarColor = "#3B82F6", avatarShape = "circle", avatarEyeColor,
  avatarGlasses = false, avatarMustache = false, avatarImage, name, className, active = false,
}: BotAvatarProps) {
  if (avatarImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarImage}
        alt={name ? `${name}のアバター` : "ボットアバター"}
        width={size}
        height={size}
        className={cx("shrink-0 rounded-full object-cover", active && "bot-avatar-working", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const face = BOT_AVATAR_SHAPES.find((item) => item.id === avatarShape) ?? BOT_AVATAR_SHAPES[0];
  const ink = isAvatarColor(avatarEyeColor) ? avatarEyeColor : autoEyeColor(avatarColor);
  return (
    <svg
      aria-label={name ? `${name}のアバター` : "ボットアバター"}
      role="img"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cx("shrink-0", active && "bot-avatar-working", className)}
      style={{ color: avatarColor }}
    >
      <path d={face.path} fill="currentColor" />
      <g transform={`translate(0 ${face.eyeOffset})`} fill={ink}>
        <g className={active ? "bot-avatar-eyes" : undefined}>
          <rect x="32" y="27" width="9" height="20" rx="4.5" transform="rotate(-18 36.5 37)" />
          <rect x="59" y="24" width="9" height="20" rx="4.5" transform="rotate(-18 63.5 34)" />
        </g>
        {avatarGlasses && (
          <g data-part="glasses" fill="none" stroke={ink} strokeWidth="4" strokeLinecap="round">
            <rect x="24" y="25" width="25" height="24" rx="8" />
            <rect x="53" y="22" width="25" height="24" rx="8" />
            <path d="M49 35 53 32" />
          </g>
        )}
        {avatarMustache && (
          <path data-part="mustache" transform="translate(0 6)" d="M50 55C45 50 36 49 31 53 27 56 28 62 33 63 39 64 46 60 50 55ZM50 55C55 50 64 49 69 53 73 56 72 62 67 63 61 64 54 60 50 55Z" />
        )}
      </g>
    </svg>
  );
}
