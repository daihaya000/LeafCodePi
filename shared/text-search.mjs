/**
 * Plain-text search shared by the server (session history search) and the browser (timeline highlight).
 *
 * Matching folds case, width (NFKC) and whitespace. Folding never changes the UTF-16 length of a
 * character, so an offset in folded text is the same offset in the source text and no index map is
 * needed to highlight or cut a snippet from the original.
 */

export const MAX_SEARCH_QUERY_CHARS = 200;
export const MAX_SEARCH_TERMS = 6;
const MAX_TERM_CHARS = 200;
const MAX_RANGES = 5_000;

const ASCII_ONLY = /^[\u0000-\u007f]*$/;
const ASCII_WHITESPACE = /[\t\n\v\f\r]/g;
// Kana and CJK ideographs are unchanged by NFKC + lower-casing (the few exceptions would fall back to
// themselves anyway because their folded form is longer), so long runs skip the per-character work.
const INVARIANT_RUN = /[\u3041-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/gu;
const WHITESPACE = /\s/u;
const foldCache = new Map();
const FOLD_CACHE_LIMIT = 4_096;

/** Fold one code point to a string of the same UTF-16 length (identity when no such fold exists). */
function foldCodePoint(ch) {
  if (ch.length === 1) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 0x20);
      if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d) return " ";
      return ch;
    }
  }
  const cached = foldCache.get(ch);
  if (cached !== undefined) return cached;
  let folded = ch;
  if (WHITESPACE.test(ch)) {
    folded = " ".repeat(ch.length);
  } else {
    const lowered = ch.normalize("NFKC").toLowerCase();
    if (lowered.length === ch.length) folded = lowered;
    else {
      const plain = ch.toLowerCase();
      if (plain.length === ch.length) folded = plain;
    }
  }
  if (foldCache.size >= FOLD_CACHE_LIMIT) foldCache.clear();
  foldCache.set(ch, folded);
  return folded;
}

function foldSlice(text) {
  let out = "";
  for (const ch of text) out += foldCodePoint(ch);
  return out;
}

/** Case-, width- and whitespace-insensitive form of `text` with exactly the same length. */
export function foldForSearch(text) {
  if (typeof text !== "string" || text === "") return "";
  if (ASCII_ONLY.test(text)) return text.replace(ASCII_WHITESPACE, " ").toLowerCase();
  let out = "";
  let last = 0;
  for (const match of text.matchAll(INVARIANT_RUN)) {
    if (match.index > last) out += foldSlice(text.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  if (last < text.length) out += foldSlice(text.slice(last));
  return out;
}

/**
 * Split a query into folded terms. Words are separated by whitespace and must all match (AND);
 * "double quotes" keep a phrase together. Returns [] for an empty query.
 */
export function parseSearchQuery(query) {
  if (typeof query !== "string") return [];
  const source = query.slice(0, MAX_SEARCH_QUERY_CHARS);
  const terms = [];
  const seen = new Set();
  for (const match of source.matchAll(/"([^"]*)(?:"|$)|(\S+)/gu)) {
    const term = foldForSearch(match[1] ?? match[2] ?? "").trim().slice(0, MAX_TERM_CHARS);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms;
}

/**
 * Sorted, non-overlapping [start, end) offsets covering every occurrence of every term in
 * `foldedText`. With `requireAll` (default) a text that lacks any term yields null.
 */
export function findTermRanges(foldedText, terms, { requireAll = true, maxRanges = MAX_RANGES } = {}) {
  if (!foldedText || terms.length === 0) return requireAll ? null : [];
  const raw = [];
  for (const term of terms) {
    let found = 0;
    let from = 0;
    while (raw.length < maxRanges) {
      const at = foldedText.indexOf(term, from);
      if (at < 0) break;
      raw.push([at, at + term.length]);
      found += 1;
      from = at + term.length;
    }
    if (found === 0 && requireAll) return null;
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * A short, single-line excerpt of `source` around the first range, with the ranges that fall inside
 * it re-based onto the excerpt. Whitespace runs collapse to one space and a cut edge shows "…".
 */
export function buildSnippet(source, ranges, { before = 36, after = 90 } = {}) {
  const first = ranges[0];
  if (!first) return { text: "", highlights: [] };
  let start = Math.max(0, first[0] - before);
  let end = Math.min(source.length, Math.max(first[1], first[0]) + after);
  if (start > 0 && isLowSurrogate(source.charCodeAt(start))) start -= 1;
  if (end < source.length && isHighSurrogate(source.charCodeAt(end - 1))) end += 1;
  const slice = source.slice(start, end);
  // cleanedIndex[i] is where source offset (start + i) lands in the collapsed text.
  const cleanedIndex = new Array(slice.length + 1);
  let cleaned = "";
  let pendingSpace = false;
  for (let index = 0; index < slice.length; index += 1) {
    const char = slice[index];
    if (WHITESPACE.test(char)) {
      // A range that ends on whitespace ends where the collapsed text ends so far.
      cleanedIndex[index] = cleaned.length;
      if (cleaned !== "") pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      cleaned += " ";
      pendingSpace = false;
    }
    cleanedIndex[index] = cleaned.length;
    cleaned += char;
  }
  cleanedIndex[slice.length] = cleaned.length;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";
  const highlights = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeEnd <= start || rangeStart >= end) continue;
    const from = cleanedIndex[Math.max(rangeStart, start) - start];
    const to = Math.min(cleanedIndex[Math.min(rangeEnd, end) - start], cleaned.length);
    if (to > from) highlights.push([from + prefix.length, to + prefix.length]);
  }
  return { text: `${prefix}${cleaned}${suffix}`, highlights };
}
