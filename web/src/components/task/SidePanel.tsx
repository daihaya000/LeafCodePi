"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

const SIDE_PANEL_MIN_WIDTH = 240;
const SIDE_PANEL_DEFAULT_WIDTH = 320;
const SIDE_PANEL_MAX_WIDTH = 640;

export function readSidePanelWidth(storageKey: string): number {
  if (typeof window === "undefined") return SIDE_PANEL_DEFAULT_WIDTH;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= SIDE_PANEL_MIN_WIDTH
      ? Math.min(saved, SIDE_PANEL_MAX_WIDTH)
      : SIDE_PANEL_DEFAULT_WIDTH;
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

/** 右側パネル（Graph / Diff）の幅を左端ドラッグで調整できるラッパー。 */
export function SidePanel({
  storageKey,
  children,
  className,
  onWidthChange,
}: {
  storageKey: string;
  children: ReactNode;
  className?: string;
  onWidthChange?: (width: number) => void;
}) {
  const [width, setWidth] = useState(() => readSidePanelWidth(storageKey));
  useEffect(() => {
    setWidth(readSidePanelWidth(storageKey));
  }, [storageKey]);
  return (
    <div
      className={`relative flex h-full min-h-0 shrink-0 flex-col border-b border-border md:h-72 lg:h-auto lg:w-(--panel-width) lg:border-b-0 lg:border-l ${className ?? ""}`}
      style={{ "--panel-width": `${width}px` } as CSSProperties}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="パネルの幅を調整"
        className="absolute top-0 left-0 hidden h-full w-1 cursor-col-resize lg:block"
        onPointerDown={(event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = width;
          let nextWidth = width;
          const previousUserSelect = document.body.style.userSelect;
          document.body.style.userSelect = "none";
          const onMove = (move: PointerEvent) => {
            nextWidth = Math.min(
              SIDE_PANEL_MAX_WIDTH,
              Math.max(SIDE_PANEL_MIN_WIDTH, startWidth - (move.clientX - startX)),
            );
            setWidth(nextWidth);
          };
          const onUp = () => {
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            window.removeEventListener("blur", onUp);
            localStorage.setItem(storageKey, String(nextWidth));
            onWidthChange?.(nextWidth);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onUp);
          window.addEventListener("blur", onUp);
        }}
      />
    </div>
  );
}
