// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DraftLinkPreviews, MarkdownLink, UrlAttachmentText } from "./LinkPreviewCard";
import { remarkLinkCards } from "@/lib/remark-link-cards";
import { normalizeLinkUrl, splitUrlAttachments } from "@/lib/link-preview-shared";
const request = vi.fn();
beforeEach(() => {
  request.mockReset().mockResolvedValue(new Response(JSON.stringify({ title: "公開Notionページ", description: "ページの説明", siteName: "Notion", image: `/api/link-preview/image?id=${"a".repeat(32)}` })));
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("renders standalone Markdown links as cards with same-origin thumbnails, without changing inline links", async () => {
  const { container } = render(<Markdown remarkPlugins={[remarkGfm, remarkLinkCards]} components={{ a: MarkdownLink }}>{"https://example.notion.site/card1\n\n本文の[リンク](https://example.com/inline)"}</Markdown>);
  await screen.findByRole("link", { name: "公開Notionページ" });
  expect(screen.getByText("ページの説明")).toBeTruthy();
  expect(container.querySelector("a[data-link-card]")?.getAttribute("target")).toBe("_blank");
  expect(container.querySelector("a[data-link-card]")?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(`/api/link-preview/image?id=${"a".repeat(32)}`);
  expect(container.querySelector("img")?.getAttribute("loading")).toBe("lazy");
  expect(screen.getByRole("link", { name: "リンク" }).hasAttribute("data-link-card")).toBe(false);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0]).toBe("/api/link-preview");
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ url: "https://example.notion.site/card1" });
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link", { name: "公開Notionページ" })).toBeTruthy();
});
it("preserves internal links, code and prose and caps previews to six per message", async () => {
  request.mockResolvedValue(new Response("{}", { status: 503 }));
  const urls = Array.from({ length: 8 }, (_, index) => `https://example.com/cap${index}`);
  const source = ["[内部](/task/abc)", "", "```text", "https://example.com/code", "```", "", ...urls.flatMap((url) => [url, ""])].join("\n");
  const { container } = render(<Markdown remarkPlugins={[remarkGfm, remarkLinkCards]} components={{ a: MarkdownLink }}>{source}</Markdown>);
  expect(container.querySelectorAll("a[data-link-card]")).toHaveLength(6);
  expect(screen.getByRole("link", { name: "内部" }).getAttribute("href")).toBe("/task/abc");
  await waitFor(() => expect(request).toHaveBeenCalledTimes(6));
  expect(JSON.stringify(request.mock.calls)).not.toContain("example.com/code");
});
it("keeps a clickable labelled fallback when metadata is unavailable and ignores external image responses", async () => {
  request.mockResolvedValue(new Response("offline", { status: 503 }));
  const { rerender, container } = render(<UrlAttachmentText text={"参考\n[資料](https://example.com/fallback)\n続き"} />);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(screen.getByRole("link", { name: "資料" })).toBeTruthy();
  expect(container.textContent).toContain("参考");
  expect(container.textContent).toContain("続き");
  request.mockResolvedValue(new Response(JSON.stringify({ title: "外部画像", image: "https://attacker.example/track.png" })));
  rerender(<UrlAttachmentText text="https://example.com/external-image" />);
  await screen.findByRole("link", { name: "外部画像" });
  expect(container.querySelector("img")).toBeNull();
});
it("deduplicates mounted identical URLs and defers offscreen metadata requests", async () => {
  let reveal: IntersectionObserverCallback | undefined;
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { reveal = callback; } observe() {} disconnect() {} });
  render(<UrlAttachmentText text="https://example.com/lazy" />);
  expect(request).not.toHaveBeenCalled();
  await act(async () => reveal!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  vi.stubGlobal("IntersectionObserver", undefined);
  render(<UrlAttachmentText text="https://example.com/lazy" />);
  await act(async () => {});
  expect(request).toHaveBeenCalledOnce();
});
it("debounces draft attachments and immediately removes deleted URLs without altering prompt text", async () => {
  vi.useFakeTimers();
  const { rerender, container } = render(<DraftLinkPreviews text="https://example.com/draft" />);
  expect(container.querySelector("a")).toBeNull();
  await act(async () => { vi.advanceTimersByTime(450); });
  expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/draft");
  rerender(<DraftLinkPreviews text="" />);
  expect(container.querySelector("a")).toBeNull();
});
it("preserves linked Markdown images instead of replacing them with URL cards", () => {
  const { container } = render(<Markdown remarkPlugins={[remarkGfm, remarkLinkCards]} components={{ a: MarkdownLink }}>{"[![render](./render.png)](https://example.com/linked-image)"}</Markdown>);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("./render.png");
  expect(container.querySelector("[data-link-card]")).toBeNull();
});
it("shares metadata across fragment variants while preserving each link destination", async () => {
  const { container } = render(<UrlAttachmentText text={"https://example.com/fragment-cache#one\nhttps://example.com/fragment-cache#two"} />);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  expect(request).toHaveBeenCalledOnce();
  expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/fragment-cache#one", "https://example.com/fragment-cache#two"]);
});
it("preserves literal fenced code and rejects credentials, non-HTTP and nonstandard ports", () => {
  const text = "before\n```text\nhttps://example.com/code\n```\nafter";
  expect(splitUrlAttachments(text)).toEqual([{ text }]);
  for (const value of ["javascript:alert(1)", "file:///tmp/x", "https://user:secret@example.com", "https://example.com:444", "https://example.com/\nsecret"]) expect(normalizeLinkUrl(value)).toBeNull();
  expect(normalizeLinkUrl("https://example.com/path#anchor")).toBe("https://example.com/path#anchor");
});
