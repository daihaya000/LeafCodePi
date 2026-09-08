import { isValidElement, type ReactNode } from "react";
import { BotAvatar } from "@/components/bot/BotAvatar";
import type { BotDto } from "@/lib/types";

const SPECIAL_MENTIONS = ["here", "channel", "everyone", "all"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chip for an addressed participant, so a handoff is recognisable without reading the sentence. */
function MentionChip({ bot, label, tone }: { bot?: BotDto; label: string; tone: "user" | "bot" }) {
  const className = tone === "user"
    ? "bg-white/90 text-accent"
    : "bg-surface-3 text-text";
  return (
    <span data-mention={bot?.id ?? label} className={`mx-0.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 align-baseline font-medium ${className}`}>
      {bot && <BotAvatar size={20} {...bot} />}
      {bot ? bot.name : label}
    </span>
  );
}

/** Split plain text on @mentions of room members (and the group-wide aliases). */
export function renderMentions(text: string, bots: BotDto[], keyPrefix: string, tone: "user" | "bot" = "bot"): ReactNode[] {
  const names = [...SPECIAL_MENTIONS, ...bots.map((bot) => bot.name.trim())].filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (names.length === 0) return [text];
  const pattern = new RegExp(`@(?:${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}\\p{M}_-])`, "giu");
  const parts: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const label = match[0].slice(1);
    const bot = bots.find((member) => member.name.trim().toLocaleLowerCase() === label.toLocaleLowerCase());
    parts.push(<MentionChip key={`${keyPrefix}-mention-${index++}`} bot={bot} label={match[0]} tone={tone} />);
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
}

/** Apply mention chips to the text inside already-rendered Markdown children. */
export function withMentions(children: ReactNode, bots: BotDto[], keyPrefix: string): ReactNode {
  if (typeof children === "string") return renderMentions(children, bots, keyPrefix);
  if (Array.isArray(children)) return children.map((child, index) => <span key={`${keyPrefix}-${index}`}>{withMentions(child, bots, `${keyPrefix}-${index}`)}</span>);
  // Nested elements keep their own renderer; only bare text is rewritten.
  return isValidElement(children) ? children : children;
}
