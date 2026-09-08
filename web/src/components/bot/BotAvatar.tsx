import { cx } from "@/components/ui";
import { autoEyeColor, BOT_AVATAR_SHAPES, isAvatarEyeColor, type BotAvatarShape } from "@/lib/bot-avatar";

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
  const ink = isAvatarEyeColor(avatarEyeColor) ? avatarEyeColor : autoEyeColor(avatarColor);
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
          <rect x={avatarGlasses ? 33 : 32} y={avatarGlasses ? 29 : 27} width={avatarGlasses ? 7 : 9} height={avatarGlasses ? 16 : 20} rx={avatarGlasses ? 3.5 : 4.5} transform="rotate(-18 36.5 37)" />
          <rect x={avatarGlasses ? 60 : 59} y={avatarGlasses ? 26 : 24} width={avatarGlasses ? 7 : 9} height={avatarGlasses ? 16 : 20} rx={avatarGlasses ? 3.5 : 4.5} transform="rotate(-18 63.5 34)" />
        </g>
        {avatarGlasses && (
          <g data-part="glasses" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="36.5" cy="37" r="12" />
            <circle cx="63.5" cy="34" r="12" />
            <path d="M48.5 35.5Q50 32 51.5 35M24.5 35 20 33M75.5 32 80 29" />
          </g>
        )}
        {avatarMustache && (
          <path data-part="mustache" d="M50 61C45 54 39 55 34 60C29 65 25 64 23 58C21 69 30 74 39 70C44 68 47 65 50 63C53 65 56 68 61 70C70 74 79 69 77 58C75 64 71 65 66 60C61 55 55 54 50 61Z" />
        )}
      </g>
    </svg>
  );
}
