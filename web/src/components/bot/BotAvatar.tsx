import { cx } from "@/components/ui";

type BotAvatarProps = {
  size?: number;
  color?: string;
  /** アップロードされたアバター画像（data URL）。あれば幾何学顔アイコンより優先する。 */
  image?: string | null;
  name?: string;
  className?: string;
  /** Activity cue shared by generated faces and uploaded avatars. */
  active?: boolean;
};

/** Small geometric bot face used consistently throughout Bot mode; falls back from an uploaded image. */
export function BotAvatar({ size = 32, color = "#3B82F6", image, name, className, active = false }: BotAvatarProps) {
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
      <circle cx="50" cy="50" r="50" fill="currentColor" />
      <g className={active ? "bot-avatar-eyes" : undefined}>
      <rect x="32" y="27" width="9" height="20" rx="4.5" fill="white" transform="rotate(-18 36.5 37)" />
      <rect x="59" y="24" width="9" height="20" rx="4.5" fill="white" transform="rotate(-18 63.5 34)" />
      </g>
    </svg>
  );
}
