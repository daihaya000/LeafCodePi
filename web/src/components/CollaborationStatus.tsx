"use client";

import { AlertTriangle, MessageCircle, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { getJson } from "@/lib/client";
import type { CollaborationRoomSummary } from "@/lib/collaboration-room";

export function useCollaborationRoom(projectId?: string | null): CollaborationRoomSummary | null {
  const [room, setRoom] = useState<CollaborationRoomSummary | null>(null);

  useEffect(() => {
    if (!projectId) {
      setRoom(null);
      return;
    }
    let closed = false;
    const refresh = async () => {
      try {
        const response = await getJson<{ room: CollaborationRoomSummary }>(`/api/collaboration?projectId=${encodeURIComponent(projectId)}`);
        if (!closed) setRoom(response.room);
      } catch {
        if (!closed) setRoom(null);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [projectId]);

  return room;
}

export function CollaborationBadge({ room, className }: { room: CollaborationRoomSummary | undefined; className?: string }) {
  if (!room) return null;
  const attention = room.leaseConflicts > 0 || room.pendingAsks > 0;
  const label = [
    `${room.peers}セッション接続中`,
    room.leaseConflicts > 0 ? `競合${room.leaseConflicts}件` : "",
    room.pendingAsks > 0 ? `未処理ask${room.pendingAsks}件` : "",
    !room.ready ? "room状態を確認できません" : "",
  ].filter(Boolean).join("、");
  return (
    <span
      title={room.reason ? `${label}。${room.reason}` : label}
      aria-label={label}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        !room.ready ? "bg-surface-2 text-muted" : attention ? "bg-warning-bg text-warning" : "bg-surface-2 text-muted",
        className,
      )}
    >
      <Users aria-hidden="true" className="h-3 w-3" />
      <span className="tabular-nums">{room.peers}</span>
      {room.leaseConflicts > 0 && <AlertTriangle aria-hidden="true" className="h-3 w-3 text-danger" />}
      {room.pendingAsks > 0 && <MessageCircle aria-hidden="true" className="h-3 w-3 text-accent" />}
    </span>
  );
}

export function CollaborationNotice({ room }: { room: CollaborationRoomSummary | null }) {
  if (!room || (!room.leaseConflicts && !room.pendingAsks && room.ready)) return null;
  const message = !room.ready
    ? `協調roomを確認できません${room.reason ? `: ${room.reason}` : ""}`
    : [
        room.leaseConflicts > 0 ? `lease競合 ${room.leaseConflicts}件` : "",
        room.pendingAsks > 0 ? `未処理ask ${room.pendingAsks}件` : "",
      ].filter(Boolean).join(" / ");
  return (
    <div
      role="status"
      className={cx(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        room.ready ? "border-warning/30 bg-warning-bg text-warning" : "border-border bg-surface-2 text-muted",
      )}
    >
      {room.ready ? <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <Users aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}
