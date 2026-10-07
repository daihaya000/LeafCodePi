"use client";

import { Children, Fragment, isValidElement, memo, useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { Globe, Link as LinkIcon } from "lucide-react";
import { isSensitivePreviewUrl, normalizeLinkUrl, splitUrlAttachments, type LinkPreview } from "@/lib/link-preview-shared";

const previews = new Map<string, { work: Promise<LinkPreview | null>; expires: number }>();
function loadPreview(url: string): Promise<LinkPreview | null> {
  for (const [key, cached] of previews) if (cached.expires < Date.now()) previews.delete(key);
  const cached = previews.get(url);
  if (cached) return cached.work;
  const work: Promise<LinkPreview | null> = fetch("/api/link-preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), cache: "no-store", signal: AbortSignal.timeout(8000),
  }).then(async (response) => {
    if (!response.ok) return null;
    const value = await response.json() as Partial<LinkPreview> | null;
    if (!value || typeof value.title !== "string") return null;
    return {
      url, title: value.title.slice(0, 200),
      description: typeof value.description === "string" ? value.description.slice(0, 400) : undefined,
      siteName: typeof value.siteName === "string" ? value.siteName.slice(0, 80) : undefined,
      image: typeof value.image === "string" && /^\/api\/link-preview\/image\?id=[a-f0-9]{32}$/.test(value.image) ? value.image : undefined,
    };
  }).catch(() => null);
  previews.set(url, { work, expires: Date.now() + 2 * 60_000 });
  while (previews.size > 128) previews.delete(previews.keys().next().value!);
  return work;
}
function textOf(children: ReactNode): string {
  return Children.toArray(children).map((child) => typeof child === "string" || typeof child === "number" ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : "").join("");
}

function PreviewCard({ url, label }: { url: string; label?: string }) {
  const root = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const host = new URL(url).hostname.replace(/^www\./, "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || isSensitivePreviewUrl(url)) return;
    let active = true;
    // Streaming assistant URLs can change token by token; wait for a stable destination.
    const timer = setTimeout(() => {
      void loadPreview(url).then((result) => { if (active) setPreview(result); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [url, visible]);
  const title = preview?.title && preview.title !== new URL(url).hostname ? preview.title : label || preview?.title || host;
  return (
    <a ref={root} href={url} target="_blank" rel="noopener noreferrer" data-link-card="" aria-label={title}
      className="my-2 flex w-full max-w-full min-h-32 overflow-hidden rounded-card border border-border bg-surface text-left text-text no-underline transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent whitespace-normal">
      <span className="relative flex w-24 shrink-0 items-center justify-center self-stretch bg-surface-2 sm:w-36" aria-hidden="true">
        {preview?.image && !imageFailed
          // Metadata-selected images are served by the bounded same-origin proxy, never fetched directly by the browser.
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={preview.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} className="absolute inset-0 h-full w-full object-cover" />
          : <LinkIcon className="h-6 w-6 text-faint" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2 p-3 sm:p-4">
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted"><Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{preview?.siteName || host}</span></span>
        <span className="line-clamp-2 break-words text-sm font-medium text-text sm:text-base">{title}</span>
        {preview?.description && <span className="line-clamp-2 break-words text-sm text-muted">{preview.description}</span>}
        <span className="mt-auto truncate text-xs text-faint">{url}</span>
      </span>
    </a>
  );
}
export const LinkPreviewCard = memo(function LinkPreviewCard({ url, label }: { url: string; label?: string }) {
  const normalized = normalizeLinkUrl(url);
  if (!normalized) return <span>{label || url}</span>;
  return <PreviewCard key={normalized} url={normalized} label={label?.slice(0, 200)} />;
});

export function MarkdownLink({ node, href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  if (href && node?.properties["data-link-preview"] && normalizeLinkUrl(href)) {
    return <LinkPreviewCard url={href} label={textOf(children)} />;
  }
  return <a href={href} {...props}>{children}</a>;
}
export function UrlAttachmentText({ text, renderText = (value) => value }: { text: string; renderText?: (value: string) => ReactNode }) {
  return <>{splitUrlAttachments(text).map((segment, index) => "url" in segment
    ? <LinkPreviewCard key={`${segment.url}:${index}`} url={segment.url} label={segment.label} />
    : <Fragment key={index}>{renderText(segment.text)}</Fragment>)}</>;
}
export function DraftLinkPreviews({ text }: { text: string }) {
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), 450);
    return () => clearTimeout(timer);
  }, [text]);
  // Remove a deleted URL at once; only new/edited URLs wait for the typing debounce.
  const current = new Set(splitUrlAttachments(text, 3).flatMap((segment) => "url" in segment ? [segment.url] : []));
  const urls = splitUrlAttachments(settled, 3).filter((segment) => "url" in segment && current.has(segment.url));
  if (!urls.length) return null;
  return <div aria-label="URL添付プレビュー">{urls.map((segment) => "url" in segment && <LinkPreviewCard key={segment.url} url={segment.url} label={segment.label} />)}</div>;
}
