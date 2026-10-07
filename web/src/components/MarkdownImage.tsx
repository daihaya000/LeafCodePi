"use client";

import { createContext, memo, useContext, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { Image as ImageIcon, ImageOff } from "lucide-react";
import { defaultUrlTransform, type ExtraProps, type UrlTransform } from "react-markdown";
import { ImageLightbox } from "@/components/Composer";
import { mediaFormatForPath, type MediaKind } from "@/lib/media-formats";
import { classifyMarkdownMediaSource, decodeMediaPath, type MarkdownMediaSource } from "@/lib/markdown-media-source";

const ImageTaskContext = createContext<string | undefined>(undefined);

export function MarkdownImageScope({ taskId, children }: { taskId?: string; children: ReactNode }) {
  return <ImageTaskContext.Provider value={taskId}>{children}</ImageTaskContext.Provider>;
}

type ImageSource = MarkdownMediaSource;
export const classifyMarkdownImageSource = classifyMarkdownMediaSource;

export function markdownImageUrlTransform(
  url: string,
  key: string,
  _node?: Parameters<UrlTransform>[2],
): string {
  void _node;
  if (key !== "src") return defaultUrlTransform(url);
  return classifyMarkdownImageSource(url).kind === "invalid" ? "" : url;
}

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & ExtraProps;

function UnavailableImage({ label, reason }: { label: string; reason: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs text-muted"
      title={label}
    >
      <ImageOff className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
      <span className="min-w-0 truncate">{reason}</span>
      {label && <span className="min-w-0 max-w-48 truncate text-faint">{label}</span>}
    </span>
  );
}

function ImagePreview({ src, alt, taskId }: { src: string; alt: string; taskId?: string }) {
  const [externalRequested, setExternalRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = classifyMarkdownImageSource(src);
  if (source.kind === "invalid") return <UnavailableImage label={source.label} reason="表示できない画像" />;
  if (failed) return <UnavailableImage label={alt || src} reason="画像を読み込めません" />;

  if (source.kind === "remote" && !externalRequested) {
    return (
      <button
        type="button"
        onClick={() => setExternalRequested(true)}
        className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs text-accent hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`外部画像を読み込む: ${source.host}`}
        title={source.url}
      >
        <ImageIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>外部画像を読み込む</span>
        <span className="max-w-48 truncate text-faint">{source.host}</span>
      </button>
    );
  }

  if (!taskId && source.kind === "local") {
    return <UnavailableImage label={alt || source.path} reason="タスクの画像を表示できません" />;
  }
  const imageUrl = source.kind === "remote"
    ? source.url
    : `/api/tasks/${encodeURIComponent(taskId!)}/image?path=${encodeURIComponent(source.path)}`;
  return (
    <ImageLightbox
      src={imageUrl}
      alt={alt || (source.kind === "local" ? source.path : "外部画像")}
      className="max-h-80 max-w-full rounded-xl border border-border bg-surface-2 object-contain"
      triggerClassName="w-fit max-w-full"
      onError={() => setFailed(true)}
      referrerPolicy={source.kind === "remote" ? "no-referrer" : undefined}
    />
  );
}

function MediaPreview({ source, kind, alt, taskId }: {
  source: Exclude<ImageSource, { kind: "invalid" }>; kind: MediaKind; alt: string; taskId?: string;
}) {
  const [failed, setFailed] = useState(false);
  const label = kind === "video" ? "動画" : "音声";
  if (source.kind === "remote") return (
    <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-accent">
      外部{label}を開く: {alt || source.host}
    </a>
  );
  if (!taskId) return <UnavailableImage label={alt} reason={`タスクの${label}を表示できません`} />;
  const url = `/api/tasks/${encodeURIComponent(taskId)}/media?path=${encodeURIComponent(source.path)}`;
  const props = { src: url, controls: true, preload: "none" as const, "aria-label": alt || label, onError: () => setFailed(true) };
  return (
    <span className="inline-flex max-w-full flex-col gap-2 rounded-lg border border-border bg-surface-2 p-2 text-xs text-muted">
      {failed ? <span role="alert">再生できません。ブラウザの対応形式を確認するかダウンロードしてください。</span>
        : kind === "video" ? <video {...props} playsInline className="max-h-80 max-w-full rounded-lg" />
          : <audio {...props} className="max-w-full" />}
      <span>{alt || label} <a href={url} download className="text-accent">ダウンロード</a></span>
    </span>
  );
}

export const MarkdownImage = memo(function MarkdownImage({ src, alt }: MarkdownImageProps) {
  const taskId = useContext(ImageTaskContext);
  if (typeof src !== "string" || !src) return <UnavailableImage label={alt ?? ""} reason="画像パスが空です" />;
  const source = classifyMarkdownImageSource(src);
  const format = source.kind === "invalid" ? undefined : mediaFormatForPath(
    source.kind === "local" ? source.path : decodeMediaPath(new URL(source.url).pathname),
  );
  if (source.kind !== "invalid" && format) return (
    <MediaPreview key={`${taskId ?? ""}:${src}`} source={source} kind={format.kind} alt={alt ?? ""} taskId={taskId} />
  );
  return <ImagePreview key={`${taskId ?? ""}:${src}`} src={src} alt={alt ?? ""} taskId={taskId} />;
});

/** Shared React Markdown options for message bodies. */
export const markdownImageComponents = { img: MarkdownImage };
