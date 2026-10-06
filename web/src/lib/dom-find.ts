import { findTermRanges, foldForSearch } from "@shared/text-search.mjs";

/** Marks an element whose text is conversation text: the part of a message that search covers. */
export const SEARCH_TEXT_ATTRIBUTE = "data-search-text";
/** On a message `<article>`: the id of the message it renders. */
export const MESSAGE_ID_ATTRIBUTE = "data-message-id";
/** On a timeline row: the ids of every message the row renders (space separated). */
export const MESSAGE_IDS_ATTRIBUTE = "data-message-ids";

type HighlightNames = { all: string; active: string; styleId: string };
const DEFAULT_HIGHLIGHT_SCOPE = {};
const DEFAULT_HIGHLIGHT_NAMES: HighlightNames = {
  all: "session-search",
  active: "session-search-active",
  styleId: "leafcode-find-highlight",
};
const highlightNamesByScope = new WeakMap<object, HighlightNames>();
let nextHighlightScopeId = 1;
// Injected at run time instead of living in globals.css: the CSS build pipeline cannot parse ::highlight().
function namesForScope(scope: object): HighlightNames {
  if (scope === DEFAULT_HIGHLIGHT_SCOPE) return DEFAULT_HIGHLIGHT_NAMES;
  const cached = highlightNamesByScope.get(scope);
  if (cached) return cached;
  const id = nextHighlightScopeId++;
  const names = {
    all: `session-search-${id}`,
    active: `session-search-active-${id}`,
    styleId: `leafcode-find-highlight-${id}`,
  };
  highlightNamesByScope.set(scope, names);
  return names;
}
const MAX_MATCHES = 3_000;
// Text on either side of one of these never joins into a single match.
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
  "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL",
  "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
const SHOW_ELEMENT_AND_TEXT = 1 | 4;

export type DomMatch = {
  range: Range;
  /** The message the matching text belongs to (null when its article carries no id). */
  messageId: string | null;
};

function blockOf(node: Node, container: Element): Element {
  for (let element = node.parentElement; element && element !== container; element = element.parentElement) {
    if (BLOCK_TAGS.has(element.tagName)) return element;
  }
  return container;
}

/** The index of the node holding the character at `offset`, or -1 when it falls between nodes. */
function nodeIndexAt(starts: readonly number[], nodes: readonly Text[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle]! <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 && offset - starts[found]! < nodes[found]!.length ? found : -1;
}

function collectContainerMatches(container: Element, terms: readonly string[], out: DomMatch[], limit: number): void {
  const document = container.ownerDocument;
  const walker = document.createTreeWalker(container, SHOW_ELEMENT_AND_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let combined = "";
  let previousBlock: Element | null = null;
  let breakPending = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if ((node as Element).tagName === "BR") breakPending = true;
      continue;
    }
    const text = node as Text;
    if (text.length === 0) continue;
    const block = blockOf(text, container);
    // A virtual space keeps "end of one paragraph" + "start of the next" from matching as one word.
    if (nodes.length > 0 && (breakPending || block !== previousBlock)) combined += " ";
    breakPending = false;
    previousBlock = block;
    starts.push(combined.length);
    nodes.push(text);
    combined += text.data;
  }
  if (nodes.length === 0) return;
  const messageId = container.closest(`[${MESSAGE_ID_ATTRIBUTE}]`)?.getAttribute(MESSAGE_ID_ATTRIBUTE) ?? null;
  const ranges = findTermRanges(foldForSearch(combined), terms, { requireAll: false });
  for (const [start, end] of ranges ?? []) {
    if (out.length >= limit) return;
    // Terms are trimmed, so the first and last matched characters are real text, never the virtual space.
    const first = nodeIndexAt(starts, nodes, start);
    const last = nodeIndexAt(starts, nodes, end - 1);
    if (first < 0 || last < 0) continue;
    const range = document.createRange();
    range.setStart(nodes[first]!, start - starts[first]!);
    range.setEnd(nodes[last]!, end - starts[last]!);
    out.push({ range, messageId });
  }
}

/** Every occurrence of any term inside the conversation text under `root` (see SEARCH_TEXT_ATTRIBUTE). */
export function collectMatches(root: ParentNode, terms: readonly string[], limit = MAX_MATCHES): DomMatch[] {
  const matches: DomMatch[] = [];
  if (terms.length === 0) return matches;
  for (const container of root.querySelectorAll(`[${SEARCH_TEXT_ATTRIBUTE}]`)) {
    if (matches.length >= limit) break;
    collectContainerMatches(container, terms, matches, limit);
  }
  return matches;
}

type HighlightRegistryLike = {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
};

function highlightRegistry(): HighlightRegistryLike | null {
  const registry = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights : undefined;
  return registry && typeof Highlight !== "undefined" ? registry : null;
}

function ensureHighlightStyle(names: HighlightNames): void {
  if (typeof document === "undefined" || document.getElementById(names.styleId)) return;
  const style = document.createElement("style");
  style.id = names.styleId;
  style.textContent =
    `::highlight(${names.all}){background-color:var(--find-match-bg);color:var(--find-match-fg)}` +
    `::highlight(${names.active}){background-color:var(--find-active-bg);color:var(--find-match-fg)}`;
  document.head.append(style);
}

/** Whether the CSS Custom Highlight API can paint matches in this browser. */
export function canPaintMatches(): boolean {
  return highlightRegistry() !== null;
}

/**
 * Paint matches without touching the DOM (React keeps owning it). Matches of `activeMessageId` get the
 * stronger color. Returns false where the browser has no highlight support.
 */
export function paintMatches(
  matches: readonly DomMatch[],
  activeMessageId: string | null,
  scope: object = DEFAULT_HIGHLIGHT_SCOPE,
): boolean {
  const registry = highlightRegistry();
  if (!registry) return false;
  const names = namesForScope(scope);
  ensureHighlightStyle(names);
  const others = new Highlight();
  const active = new Highlight();
  active.priority = 1;
  for (const match of matches) (match.messageId !== null && match.messageId === activeMessageId ? active : others).add(match.range);
  registry.set(names.all, others);
  registry.set(names.active, active);
  return true;
}

export function clearMatches(scope: object = DEFAULT_HIGHLIGHT_SCOPE): void {
  const names = namesForScope(scope);
  const registry = highlightRegistry();
  registry?.delete(names.all);
  registry?.delete(names.active);
  if (typeof document !== "undefined") document.getElementById(names.styleId)?.remove();
  if (scope !== DEFAULT_HIGHLIGHT_SCOPE) highlightNamesByScope.delete(scope);
}

/** The `<article>` that renders `messageId` inside `scope`, if it is mounted. */
export function findMessageArticle(scope: ParentNode, messageId: string): HTMLElement | null {
  for (const article of scope.querySelectorAll<HTMLElement>(`article[${MESSAGE_ID_ATTRIBUTE}]`)) {
    if (article.getAttribute(MESSAGE_ID_ATTRIBUTE) === messageId) return article;
  }
  return null;
}

/**
 * The timeline row to scroll to for a message: the row that shows its text, otherwise any row that
 * lists it (a collapsed work log hides the article until it is revealed).
 */
export function findMessageRow(root: ParentNode, messageId: string): HTMLElement | null {
  let fallback: HTMLElement | null = null;
  for (const row of root.querySelectorAll<HTMLElement>(`[${MESSAGE_IDS_ATTRIBUTE}]`)) {
    if (!(row.getAttribute(MESSAGE_IDS_ATTRIBUTE) ?? "").split(" ").includes(messageId)) continue;
    if (findMessageArticle(row, messageId)?.querySelector(`[${SEARCH_TEXT_ATTRIBUTE}]`)) return row;
    fallback ??= row;
  }
  return fallback;
}

/**
 * Whether an element is on screen layout-wise: it has a box of some size and sits in no closed
 * <details>. A closed <details> keeps its content's boxes (skipped, zero-sized or stale), so the
 * ancestor check cannot be left to getClientRects().
 */
export function isRendered(element: Element): boolean {
  if (element.parentElement?.closest("details:not([open])")) return false;
  const first = element.getClientRects()[0];
  return first !== undefined && (first.width > 0 || first.height > 0);
}

/** Whether the text a range covers is laid out (see isRendered). */
export function isRangeRendered(range: Range): boolean {
  const start = range.startContainer;
  const element = start.nodeType === 1 ? (start as Element) : start.parentElement;
  return element !== null && isRendered(element) && range.getClientRects().length > 0;
}

function targetRect(target: Element | Range): DOMRect {
  const first = target.getClientRects()[0];
  return first ?? target.getBoundingClientRect();
}

/**
 * Scroll `container` so `target` sits `topOffset` below its top edge. Scrollers nested between the two
 * (an open work log has its own) are centered on the target first.
 */
export function scrollTargetIntoView(container: HTMLElement, target: Element | Range, topOffset = 16): void {
  const origin = target instanceof Range
    ? (target.startContainer.nodeType === 1 ? target.startContainer as Element : target.startContainer.parentElement)
    : target;
  for (let element = origin; element && element !== container; element = element.parentElement) {
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const rect = targetRect(target);
    const box = element.getBoundingClientRect();
    element.scrollTop += rect.top - box.top - Math.max(0, (box.height - rect.height) / 2);
  }
  const rect = targetRect(target);
  container.scrollTop += rect.top - container.getBoundingClientRect().top - topOffset;
}
