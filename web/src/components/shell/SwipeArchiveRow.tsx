"use client";

import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Archive } from "lucide-react";

const ACTION_WIDTH = 64;

type SwipeStart = { x: number; y: number; offset: number };

export function SwipeArchiveRow({ children, label, disabled, onArchive }: {
  children: ReactNode;
  label: string;
  disabled?: boolean;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<SwipeStart | null>(null);
  const swiped = useRef(false);
  const vertical = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setOffset(0);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0];
    if (touch) start.current = { x: touch.clientX, y: touch.clientY, offset: open ? ACTION_WIDTH : 0 };
    swiped.current = false;
    vertical.current = false;
  }

  function onTouchMove(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0];
    const gesture = start.current;
    if (!touch || !gesture) return;
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (vertical.current) return;
    if (!dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) vertical.current = true;
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
    }
    swiped.current = true;
    setDragging(true);
    setOffset(Math.max(0, Math.min(ACTION_WIDTH, gesture.offset - dx)));
  }

  function onTouchEnd() {
    if (swiped.current) {
      const next = offset >= ACTION_WIDTH / 2;
      setOpen(next);
      setOffset(next ? ACTION_WIDTH : 0);
    }
    setDragging(false);
    start.current = null;
  }

  return (
    <div
      ref={root}
      className="relative overflow-hidden rounded-lg touch-pan-y"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        start.current = null;
        swiped.current = false;
        setDragging(false);
        setOffset(open ? ACTION_WIDTH : 0);
      }}
      onClickCapture={(event) => {
        const isAction = Boolean((event.target as Element).closest("[data-swipe-action]"));
        if (!isAction && (swiped.current || open)) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setOffset(0);
        }
        swiped.current = false;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setOffset(0);
        }
      }}
      onWheel={(event) => {
        if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || Math.abs(event.deltaX) < 12) return;
        const next = event.deltaX > 0;
        setOpen(next);
        setOffset(next ? ACTION_WIDTH : 0);
      }}
    >
      <button
        data-swipe-action
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        onFocus={() => { setOpen(true); setOffset(ACTION_WIDTH); }}
        onClick={onArchive}
        className="absolute inset-y-0 right-0 flex w-16 flex-col items-center justify-center gap-0.5 bg-danger text-[10px] font-medium text-white disabled:opacity-40"
      >
        <Archive className="h-4 w-4" aria-hidden="true" />
        <span>アーカイブ</span>
      </button>
      <div
        className={"relative z-10 bg-bg" + (dragging ? "" : " transition-transform duration-200")}
        style={{ transform: `translateX(-${offset}px)` }}
      >
        {children}
      </div>
    </div>
  );
}
