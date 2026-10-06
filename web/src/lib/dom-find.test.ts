// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canPaintMatches,
  clearMatches,
  collectMatches,
  findMessageArticle,
  findMessageRow,
  isRangeRendered,
  isRendered,
  paintMatches,
} from "./dom-find";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const texts = (matches: ReturnType<typeof collectMatches>) => matches.map((match) => match.range.toString());

describe("collectMatches", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("finds case- and width-insensitive matches in search text only", () => {
    const root = mount(`
      <article data-message-id="m1"><header>Needle in the meta row</header>
        <div data-search-text><p>A Needle and ＮＥＥＤＬＥ here</p></div>
      </article>`);
    const matches = collectMatches(root, ["needle"]);
    expect(texts(matches)).toEqual(["Needle", "ＮＥＥＤＬＥ"]);
    expect(matches.every((match) => match.messageId === "m1")).toBe(true);
  });

  it("matches across inline elements but never across paragraphs or line breaks", () => {
    const root = mount(`
      <article data-message-id="m1"><div data-search-text>
        <p>foo<strong>bar</strong>baz</p><p>qux</p>
        <p>one<br>two</p>
      </div></article>`);
    expect(texts(collectMatches(root, ["foobarbaz"]))).toEqual(["foobarbaz"]);
    expect(collectMatches(root, ["bazqux"])).toHaveLength(0);
    expect(collectMatches(root, ["onetwo"])).toHaveLength(0);
    // A phrase with a space may still span a paragraph break, as the browser's own find does.
    expect(texts(collectMatches(root, ["baz qux"]))).toEqual(["bazqux"]);
  });

  it("keeps each message's matches attributed to its own article", () => {
    const root = mount(`
      <div data-message-ids="a"><article data-message-id="a"><div data-search-text>needle one</div></article></div>
      <div data-message-ids="b"><article data-message-id="b"><div data-search-text>another needle</div></article></div>
      <div data-search-text>needle without an article</div>`);
    const matches = collectMatches(root, ["needle"]);
    expect(matches.map((match) => match.messageId)).toEqual(["a", "b", null]);
  });

  it("highlights every term of a multi-term query and merges overlaps", () => {
    const root = mount(`<article data-message-id="m"><div data-search-text>alpha beta gamma betagamma</div></article>`);
    expect(texts(collectMatches(root, ["beta", "gamma"]))).toEqual(["beta", "gamma", "betagamma"]);
    expect(texts(collectMatches(root, ["beta gamma"]))).toEqual(["beta gamma"]);
  });

  it("returns nothing for no terms and honours the match limit", () => {
    const root = mount(`<article data-message-id="m"><div data-search-text>${"x ".repeat(50)}</div></article>`);
    expect(collectMatches(root, [])).toEqual([]);
    expect(collectMatches(root, ["x"], 10)).toHaveLength(10);
  });

  it("maps a match that starts and ends in different text nodes to one range", () => {
    const root = mount(`<article data-message-id="m"><div data-search-text>He said <em>hello</em> <code>wor</code>ld</div></article>`);
    const [match] = collectMatches(root, ["hello world"]);
    expect(match?.range.toString()).toBe("hello world");
  });
});

describe("painting", () => {
  const registry = new Map<string, unknown>();

  beforeEach(() => {
    document.querySelectorAll('style[id^="leafcode-find-highlight"]').forEach((style) => style.remove());
    registry.clear();
    class FakeHighlight {
      ranges = new Set<Range>();
      priority = 0;
      add(range: Range) {
        this.ranges.add(range);
      }
    }
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.stubGlobal("CSS", { highlights: registry });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("paints the active message's matches apart from the rest and clears them", () => {
    const root = mount(`
      <article data-message-id="a"><div data-search-text>needle</div></article>
      <article data-message-id="b"><div data-search-text>needle needle</div></article>`);
    const matches = collectMatches(root, ["needle"]);
    expect(canPaintMatches()).toBe(true);
    expect(paintMatches(matches, "b")).toBe(true);
    const all = registry.get("session-search") as { ranges: Set<Range> };
    const active = registry.get("session-search-active") as { ranges: Set<Range>; priority: number };
    expect(all.ranges.size).toBe(1);
    expect(active.ranges.size).toBe(2);
    expect(active.priority).toBeGreaterThan(0);
    clearMatches();
    expect(registry.size).toBe(0);
  });

  it("keeps highlights isolated between task panes", () => {
    const root = mount(`<article data-message-id="a"><div data-search-text>needle</div></article>`);
    const matches = collectMatches(root, ["needle"]);
    const firstScope = {};
    const secondScope = {};
    paintMatches(matches, null, firstScope);
    const firstNames = new Set(registry.keys());
    paintMatches(matches, null, secondScope);
    expect(registry.size).toBe(4);

    clearMatches(secondScope);
    expect(registry.size).toBe(2);
    expect([...firstNames].every((name) => registry.has(name))).toBe(true);
    expect(document.querySelectorAll('style[id^="leafcode-find-highlight"]').length).toBe(1);

    clearMatches(firstScope);
    expect(registry.size).toBe(0);
    expect(document.querySelectorAll('style[id^="leafcode-find-highlight"]').length).toBe(0);
  });

  it("injects the highlight colors once, since the CSS pipeline cannot parse ::highlight()", () => {
    const root = mount(`<article data-message-id="a"><div data-search-text>needle</div></article>`);
    const matches = collectMatches(root, ["needle"]);
    expect(document.getElementById("leafcode-find-highlight")).toBeNull();
    paintMatches(matches, null);
    paintMatches(matches, "a");
    const styles = document.querySelectorAll("#leafcode-find-highlight");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain("::highlight(session-search)");
    expect(styles[0]?.textContent).toContain("::highlight(session-search-active)");
    expect(styles[0]?.textContent).toContain("var(--find-match-bg)");
    document.getElementById("leafcode-find-highlight")?.remove();
  });

  it("does nothing where the highlight API is missing", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("CSS", {});
    expect(canPaintMatches()).toBe(false);
    expect(paintMatches([], null)).toBe(false);
    expect(() => clearMatches()).not.toThrow();
  });
});

describe("locating messages", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("prefers the row that shows the message's text over a work-log row that merely lists it", () => {
    const root = mount(`
      <div id="log" data-message-ids="a b"><details><article data-message-id="b"><div class="tool"></div></article></details></div>
      <div id="text" data-message-ids="b"><article data-message-id="b"><div data-search-text>body</div></article></div>
      <div id="other" data-message-ids="c"><article data-message-id="c"></article></div>`);
    expect(findMessageRow(root, "b")?.id).toBe("text");
    expect(findMessageRow(root, "a")?.id).toBe("log");
    expect(findMessageRow(root, "missing")).toBeNull();
    expect(findMessageArticle(root, "c")?.getAttribute("data-message-id")).toBe("c");
    expect(findMessageArticle(root, "zzz")).toBeNull();
  });

  it("reports whether an element is laid out", () => {
    const root = mount(`<div id="x">x</div>`);
    const element = root.querySelector("#x")!;
    const rects = (value: object[]) => vi.spyOn(element, "getClientRects").mockReturnValue(value as unknown as DOMRectList);
    rects([]);
    expect(isRendered(element)).toBe(false);
    rects([{ width: 0, height: 0 }]);
    expect(isRendered(element)).toBe(false);
    rects([{ width: 10, height: 0 }]);
    expect(isRendered(element)).toBe(true);
  });

  it("treats the content of a closed details as not laid out even when it still has boxes", () => {
    const root = mount(`<details id="log"><summary>log</summary><article id="inside"><p>text</p></article></details>`);
    const details = root.querySelector("#log") as HTMLDetailsElement;
    const inside = root.querySelector("#inside")!;
    for (const element of [details, inside]) {
      vi.spyOn(element, "getClientRects").mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList);
    }
    expect(isRendered(inside)).toBe(false);
    // The details element itself is on screen; only what it holds is hidden.
    expect(isRendered(details)).toBe(true);
    details.setAttribute("open", "");
    expect(isRendered(inside)).toBe(true);
  });

  it("judges a range by the element that holds its text", () => {
    const root = mount(`<details id="log"><article><p id="p">needle</p></article></details><p id="open">needle</p>`);
    const closed = document.createRange();
    closed.selectNodeContents(root.querySelector("#p")!);
    const visible = document.createRange();
    visible.selectNodeContents(root.querySelector("#open")!);
    for (const range of [closed, visible]) {
      vi.spyOn(range, "getClientRects").mockReturnValue([{ width: 5, height: 5 }] as unknown as DOMRectList);
    }
    for (const element of root.querySelectorAll("p")) {
      vi.spyOn(element, "getClientRects").mockReturnValue([{ width: 5, height: 5 }] as unknown as DOMRectList);
    }
    expect(isRangeRendered(closed)).toBe(false);
    expect(isRangeRendered(visible)).toBe(true);
  });
});
