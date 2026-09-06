import { cx } from "@/components/ui";

type BotAvatarProps = {
  size?: number;
  color?: string;
  name?: string;
  className?: string;
};

/** Small geometric bot face used consistently throughout Bot mode. */
export function BotAvatar({ size = 32, color = "#3B82F6", name, className }: BotAvatarProps) {
  return (
    <svg
      aria-label={name ? `${name}のアバター` : "ボットアバター"}
      role="img"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cx("shrink-0", className)}
      style={{ color }}
    >
      <circle cx="50" cy="50" r="50" fill="currentColor" />
      <rect x="32" y="27" width="9" height="20" rx="4.5" fill="white" transform="rotate(-18 36.5 37)" />
      <rect x="59" y="24" width="9" height="20" rx="4.5" fill="white" transform="rotate(-18 63.5 34)" />
    </svg>
  );
}
