import { cx } from "@/components/ui";
import { avatarEyeColor, BOT_AVATAR_SHAPES, type BotAvatarShape } from "@/lib/bot-avatar";

type BotAvatarProps = {
  size?: number;
  color?: string;
  shape?: BotAvatarShape;
  /** アップロードされたアバター画像（data URL）。あれば幾何学顔アイコンより優先する。 */
  image?: string | null;
  name?: string;
  className?: string;
  /** Activity cue shared by generated faces and uploaded avatars. */
  active?: boolean;
};

/** Small geometric bot face used consistently throughout Bot mode; falls back from an uploaded image. */
export function BotAvatar({ size = 32, color = "#3B82F6", shape = "circle", image, name, className, active = false }: BotAvatarProps) {
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt={name ? `${name}のアバター` : "ボットアバター"}
        width={size}
        height={size}
        className={cx("shrink-0 rounded-full object-cover", active && "bot-avatar-working", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const face = BOT_AVATAR_SHAPES.find((item) => item.id === shape) ?? BOT_AVATAR_SHAPES[0];
  return (
    <svg
      aria-label={name ? `${name}のアバター` : "ボットアバター"}
      role="img"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cx("shrink-0", active && "bot-avatar-working", className)}
      style={{ color }}
    >
      <path d={face.path} fill="currentColor" />
      <g transform={`translate(0 ${face.eyeOffset})`} fill={avatarEyeColor(color)}>
        <g className={active ? "bot-avatar-eyes" : undefined}>
          <rect x="32" y="27" width="9" height="20" rx="4.5" transform="rotate(-18 36.5 37)" />
          <rect x="59" y="24" width="9" height="20" rx="4.5" transform="rotate(-18 63.5 34)" />
        </g>
      </g>
    </svg>
  );
}
