import type { ReactNode } from "react";
import {
  isKnownComposerReference,
  type ComposerReference,
  type ComposerReferenceKind,
} from "@/lib/composer-references";

export type ReferenceHighlightReferences = {
  skills: readonly ComposerReference[];
  agents: readonly ComposerReference[];
};

export function renderHighlightedReferenceText(
  value: string,
  references: ReferenceHighlightReferences,
): ReactNode {
  if (!value) return "\u200b";
  const parts: ReactNode[] = [];
  const pattern = /(^|\s)(\/[A-Za-z0-9_.:-]+|@[A-Za-z0-9_.:-]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const tokenStart = match.index + match[1].length;
    const token = match[2];
    if (tokenStart > cursor) parts.push(value.slice(cursor, tokenStart));
    const kind: ComposerReferenceKind = token.startsWith("/") ? "skill" : "agent";
    const rawName = token.slice(1);
    const name = kind === "skill" && rawName.toLowerCase().startsWith("skill:")
      ? rawName.slice("skill:".length)
      : rawName;
    if (isKnownComposerReference(kind, name, references)) {
      parts.push(
        <span
          key={`${tokenStart}-${token}`}
          className={kind === "skill" ? "rounded bg-accent/15 text-accent" : "rounded bg-primary/15 text-primary"}
        >
          {token}
        </span>,
      );
    } else {
      parts.push(token);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts.length > 0 ? parts : value;
}

export function ReferenceHighlight({
  text,
  references,
}: {
  text: string;
  references: ReferenceHighlightReferences;
}) {
  return <>{renderHighlightedReferenceText(text, references)}</>;
}
