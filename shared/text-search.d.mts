export const MAX_SEARCH_QUERY_CHARS: number;
export const MAX_SEARCH_TERMS: number;

/** Case-, width- and whitespace-insensitive form of `text` with exactly the same length. */
export function foldForSearch(text: string): string;

/** Folded AND-terms of a query; "double quotes" keep a phrase together. */
export function parseSearchQuery(query: unknown): string[];

/** Sorted, non-overlapping [start, end) offsets of every term occurrence, or null when a required term is missing. */
export function findTermRanges(
  foldedText: string,
  terms: readonly string[],
  options?: { requireAll?: boolean; maxRanges?: number },
): [number, number][] | null;

/** Single-line excerpt around the first range with the in-window ranges re-based onto it. */
export function buildSnippet(
  source: string,
  ranges: readonly (readonly [number, number])[],
  options?: { before?: number; after?: number },
): { text: string; highlights: [number, number][] };
