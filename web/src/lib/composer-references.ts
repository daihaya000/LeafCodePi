export type ComposerReferenceKind = "skill" | "agent";

export type ComposerReference = {
  name: string;
  description?: string;
  tools?: readonly string[];
};

export function composerReferenceToolNames(
  reference: Pick<ComposerReference, "tools">,
): string[] {
  const tools = reference.tools?.map((tool) => tool.trim()).filter(Boolean) ?? [];
  if (tools.length > 0) return tools;
  return reference.tools === undefined ? ["既定"] : ["なし"];
}

export function composerReferenceToolTitle(
  reference: Pick<ComposerReference, "tools">,
): string {
  return `ツール権限: ${composerReferenceToolNames(reference).join(", ")}`;
}

export type ComposerReferenceToken = {
  kind: ComposerReferenceKind;
  query: string;
  raw: string;
  start: number;
  end: number;
};

/** 後退ループ用: 空白・/・@ 以外は参照名の一部として扱う（日本語クエリ対応）。 */
const NON_REFERENCE = /[\s/\u0040]/;

/** Return the slash/at token immediately before the caret, when it is a reference. */
export function findComposerReferenceToken(value: string, caret: number): ComposerReferenceToken | null {
  const safeCaret = Math.max(0, Math.min(value.length, caret));
  let start = safeCaret - 1;
  // 日本語等の非 ASCII クエリも後退できるよう、非参照文字（空白・/・@）まで
  // 戻る。かな・漢字・絵文字も参照名の一部として扱う。
  while (start >= 0 && !NON_REFERENCE.test(value[start] ?? "")) start -= 1;
  const trigger = value[start];
  if (trigger !== "/" && trigger !== "@") return null;
  if (start > 0 && !/\s/.test(value[start - 1] ?? "")) {
    // 単語境界チェックは ASCII 前提（メールアドレス・パス等の誤検出防止）。
    // 日本語等の非 ASCII 直後は単語境界の概念がないため参照開始として許可する。
    if (/[\u0000-\u007f]/.test(value[start - 1] ?? "")) return null;
  }

  const raw = value.slice(start, safeCaret);
  const typedQuery = raw.slice(1);
  const query = trigger === "/" && typedQuery.toLowerCase().startsWith("skill:")
    ? typedQuery.slice("skill:".length)
    : typedQuery;
  return {
    kind: trigger === "/" ? "skill" : "agent",
    query,
    raw,
    start,
    end: safeCaret,
  };
}

/** Match references like LeafCode's fuzzy slash/at completion list. */
export function filterComposerReferences(
  references: readonly ComposerReference[],
  query: string,
  limit = 8,
): ComposerReference[] {
  const normalized = query.trim().toLocaleLowerCase();
  return references
    .map((reference, index) => {
      const name = reference.name.toLocaleLowerCase();
      if (!normalized) return { reference, score: 0, index };
      if (name === normalized) return { reference, score: 0, index };
      if (name.startsWith(normalized)) return { reference, score: 1, index };
      const position = name.indexOf(normalized);
      if (position >= 0) return { reference, score: 2 + position / 100, index };
      let cursor = 0;
      for (const character of normalized) {
        cursor = name.indexOf(character, cursor);
        if (cursor < 0) return null;
        cursor += 1;
      }
      return { reference, score: 3 + cursor / 100, index };
    })
    .filter((item): item is { reference: ComposerReference; score: number; index: number } => item !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, Math.max(1, limit))
    .map((item) => item.reference);
}

export function composerReferenceValue(kind: ComposerReferenceKind, name: string): string {
  return kind === "skill" ? `/skill:${name}` : `@${name}`;
}

/**
 * 参照トークンを選択名で置換した文字列（末尾スペース付き）を返す。
 * ユーザーが `/スキル名` と打った場合は `/` をそのまま活かし、
 * `/skill:` と打った場合は `/skill:` プレフィックスを維持する（二重スラッシュ防止）。
 */
export function composerReferenceInsertion(
  token: Pick<ComposerReferenceToken, "kind" | "raw">,
  name: string,
): string {
  if (token.kind === "agent") return `@${name} `;
  return token.raw.toLowerCase().startsWith("/skill:")
    ? `/skill:${name} `
    : `/${name} `;
}

/** Recognize only known references so ordinary paths and email addresses stay unstyled. */
export function isKnownComposerReference(
  kind: ComposerReferenceKind,
  name: string,
  references: { skills: readonly ComposerReference[]; agents: readonly ComposerReference[] },
): boolean {
  const source = kind === "skill" ? references.skills : references.agents;
  return source.some((reference) => reference.name === name);
}
