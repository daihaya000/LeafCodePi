import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SEARCH_TERMS,
  buildSnippet,
  findTermRanges,
  foldForSearch,
  parseSearchQuery,
} from "./text-search.mjs";

test("folding ignores case, width and whitespace kind", () => {
  assert.equal(foldForSearch("Hello World"), "hello world");
  assert.equal(foldForSearch("ＡＢＣ１２３！"), "abc123!");
  assert.equal(foldForSearch("ｶﾀｶﾅ"), "カタカナ");
  assert.equal(foldForSearch("a\tb\r\nc\u00a0d\u3000e"), "a b  c d e");
  assert.equal(foldForSearch(""), "");
  assert.equal(foldForSearch(undefined), "");
});

test("folding never changes the UTF-16 length of the text", () => {
  const pool = ["a", "Z", " ", "\n", "\r\n", "あ", "ガ", "漢", "ｶ", "ﾞ", "Ａ", "İ", "㌔", "ﬁ", "…", "😀", "𠮷", "ß", "Σ", "é", "\u0301"];
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let round = 0; round < 500; round += 1) {
    let text = "";
    for (let index = next() % 40; index >= 0; index -= 1) text += pool[next() % pool.length];
    assert.equal(foldForSearch(text).length, text.length, JSON.stringify(text));
  }
});

test("a long Japanese text folds without per-character work", () => {
  const text = "これは長い日本語の文章です。".repeat(80_000);
  const started = performance.now();
  const folded = foldForSearch(text);
  assert.equal(folded, text);
  assert.ok(performance.now() - started < 500);
});

test("queries split into AND terms and keep quoted phrases", () => {
  assert.deepEqual(parseSearchQuery("Foo  bar"), ["foo", "bar"]);
  assert.deepEqual(parseSearchQuery('"foo bar" baz'), ["foo bar", "baz"]);
  assert.deepEqual(parseSearchQuery('"foo bar'), ["foo bar"]);
  assert.deepEqual(parseSearchQuery("ＦＯＯ foo"), ["foo"]);
  assert.deepEqual(parseSearchQuery('  "  "  '), []);
  assert.deepEqual(parseSearchQuery(""), []);
  assert.deepEqual(parseSearchQuery(null), []);
  assert.equal(parseSearchQuery("a b c d e f g h i j").length, MAX_SEARCH_TERMS);
});

test("ranges are merged and a missing required term yields null", () => {
  const text = foldForSearch("Foo bar foobar");
  assert.deepEqual(findTermRanges(text, ["foo", "bar"]), [[0, 3], [4, 7], [8, 14]]);
  assert.deepEqual(findTermRanges(text, ["foo", "oba"]), [[0, 3], [8, 13]]);
  assert.equal(findTermRanges(text, ["foo", "missing"]), null);
  assert.deepEqual(findTermRanges(text, ["foo", "missing"], { requireAll: false }), [[0, 3], [8, 11]]);
  assert.equal(findTermRanges("", ["foo"]), null);
  assert.deepEqual(findTermRanges("", ["foo"], { requireAll: false }), []);
  assert.deepEqual(findTermRanges("aaaa", ["aa"]), [[0, 4]]);
  assert.equal(findTermRanges("a".repeat(100), ["a"], { maxRanges: 10 }).length, 1);
});

test("snippets are single-line, windowed and re-base the highlights", () => {
  const source = "first line\n\n  second   line with NEEDLE here\nthird line";
  const ranges = findTermRanges(foldForSearch(source), ["needle"]);
  const snippet = buildSnippet(source, ranges, { before: 100, after: 100 });
  assert.equal(snippet.text, "first line second line with NEEDLE here third line");
  assert.deepEqual(snippet.highlights.map(([from, to]) => snippet.text.slice(from, to)), ["NEEDLE"]);

  const long = `${"x".repeat(200)}needle${"y".repeat(200)}`;
  const cut = buildSnippet(long, findTermRanges(long, ["needle"]), { before: 5, after: 5 });
  assert.equal(cut.text, "…xxxxxneedleyyyyy…");
  assert.deepEqual(cut.highlights, [[6, 12]]);

  assert.deepEqual(buildSnippet("abc", []), { text: "", highlights: [] });
});

test("snippets highlight every match inside the window and never split a surrogate pair", () => {
  const source = "one two one";
  const both = buildSnippet(source, findTermRanges(source, ["one"]));
  assert.deepEqual(both.highlights, [[0, 3], [8, 11]]);

  const emoji = `${"😀".repeat(10)}needle${"😀".repeat(10)}`;
  const snippet = buildSnippet(emoji, findTermRanges(emoji, ["needle"]), { before: 3, after: 3 });
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(snippet.text));
  assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(snippet.text));
  assert.deepEqual(snippet.highlights.map(([from, to]) => snippet.text.slice(from, to)), ["needle"]);
});

test("a match that ends on whitespace ends before the collapsed space", () => {
  const source = "foo   bar";
  const snippet = buildSnippet(source, [[0, 3]]);
  assert.equal(snippet.text, "foo bar");
  assert.deepEqual(snippet.highlights, [[0, 3]]);
});
