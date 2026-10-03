"use client";

import { useState } from "react";
import { ImageLightbox } from "@/components/Composer";

/**
 * An image part from an older history page arrives without its base64 payload, so
 * the bytes are refetched for the single part on demand instead of re-downloading
 * the page. A part that already carries a URL renders exactly as before.
 */
export function LazyImagePart({
  taskId,
  messageId,
  partId,
  url,
  alt,
  className,
}: {
  taskId: string | undefined;
  messageId: string;
  partId: string;
  url: string;
  alt: string;
  className: string;
}) {
  const [src, setSrc] = useState(url);
  const [failed, setFailed] = useState(false);

  if (src) {
    return <ImageLightbox src={src} alt={alt} className={className} />;
  }
  // No task id (e.g. a standalone transcript view) means the part cannot be refetched.
  if (!taskId) {
    return (
      <p className="rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground">
        画像は履歴ページから読み込めません（{alt}）
      </p>
    );
  }
  if (failed) {
    return (
      <p className="rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground">
        画像を読み込めませんでした（{alt}）
      </p>
    );
  }
  return (
    <button
      type="button"
      className={`rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted ${className}`}
      onClick={async () => {
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(taskId)}/message-image?messageId=${encodeURIComponent(messageId)}&partId=${encodeURIComponent(partId)}`,
        );
        if (!response.ok) {
          setFailed(true);
          return;
        }
        const blob = await response.blob();
        setSrc(URL.createObjectURL(blob));
      }}
    >
      画像を読み込む（{alt}）
    </button>
  );
}
