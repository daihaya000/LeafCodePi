"use client";

import { AlertTriangle, MessageCircle, Users, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Button, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import type { CollaborationLeaseConflict, CollaborationRoomSummary } from "@/lib/collaboration-room";

export function useCollaborationRoom(projectId?: string | null): {
  room: CollaborationRoomSummary | null;
  refresh: () => Promise<void>;
} {
  const [room, setRoom] = useState<CollaborationRoomSummary | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setRoom(null);
      return;
    }
    try {
      const response = await getJson<{ room: CollaborationRoomSummary | null }>(`/api/collaboration?projectId=${encodeURIComponent(projectId)}`);
      setRoom(response.room);
    } catch {
      setRoom(null);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setRoom(null);
      return;
    }
    let closed = false;
    const tick = async () => {
      try {
        const response = await getJson<{ room: CollaborationRoomSummary | null }>(`/api/collaboration?projectId=${encodeURIComponent(projectId)}`);
        if (!closed) setRoom(response.room);
      } catch {
        if (!closed) setRoom(null);
      }
    };
    void tick();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, 5_000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [projectId]);

  return { room, refresh };
}

function collaborationLabel(room: CollaborationRoomSummary): string {
  const label = [
    `${room.peers}セッション接続中`,
    room.leaseConflicts > 0 ? `競合${room.leaseConflicts}件` : "",
    room.pendingAsks > 0 ? `未処理ask${room.pendingAsks}件` : "",
    !room.ready ? "room状態を確認できません" : "",
  ].filter(Boolean).join("、");
  const sessionNames = room.sessionNames.length > 0
    ? `接続中のセッション: ${room.sessionNames.join("、")}`
    : "";
  return [label, sessionNames].filter(Boolean).join("、");
}

function conflictStateLabel(state: CollaborationLeaseConflict["state"]): string {
  return state === "orphaned" ? "切断後に残った予約" : "外部変更で無効になった予約";
}

export function CollaborationNotice({
  projectId,
  room,
  onResolved,
}: {
  projectId?: string | null;
  room: CollaborationRoomSummary | null;
  onResolved?: () => void;
}) {
  const [busyLeaseId, setBusyLeaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!room || (!room.leaseConflicts && !room.pendingAsks && room.ready)) return null;
  const summary = !room.ready
    ? `協調roomを確認できません${room.reason ? `: ${room.reason}` : ""}`
    : [
        room.leaseConflicts > 0 ? `ファイル予約の競合 ${room.leaseConflicts}件` : "",
        room.pendingAsks > 0 ? `未処理ask ${room.pendingAsks}件` : "",
      ].filter(Boolean).join(" / ");
  const conflicts = room.conflicts ?? [];

  async function discardLease(leaseId: string) {
    if (!projectId) return;
    if (!window.confirm("このファイル予約を解除します。作業ツリーの変更は残ります。よろしいですか？")) return;
    setBusyLeaseId(leaseId);
    setError(null);
    try {
      await sendJson("/api/collaboration", { projectId, action: "discard", leaseId });
      onResolved?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "予約の解除に失敗しました。");
    } finally {
      setBusyLeaseId(null);
    }
  }

  return (
    <div
      className={cx(
        "flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm",
        room.ready ? "border-warning/40 bg-warning-bg text-warning" : "border-border bg-surface-2 text-muted",
      )}
    >
      <div role="status" className="flex items-start gap-2">
        {room.ready ? <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <Users aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
        <div className="min-w-0 space-y-1">
          <p className="break-words font-medium">{summary}</p>
          {room.leaseConflicts > 0 && (
            <p className="text-xs text-current/90">
              切れたセッションや外部変更で無効になったファイル予約です。他のセッションはそのパスを編集・commitできません。作業ツリーの変更は消えません。所有セッションを再開して予約を取り戻すか、不要なら予約だけ解除できます。
            </p>
          )}
          {room.pendingAsks > 0 && (
            <p className="text-xs text-current/90">
              未処理askは相手セッションが次に応答するまで残ります。こちらから強制解決はできません。
            </p>
          )}
        </div>
      </div>
      {conflicts.length > 0 && (
        <ul className="space-y-2">
          {conflicts.map((conflict) => (
            <li key={conflict.leaseId} className="rounded-md border border-current/20 bg-surface px-2 py-2 text-text">
              <p className="font-medium">{conflictStateLabel(conflict.state)}</p>
              <p className="mt-0.5 text-xs text-muted">
                所有者: {conflict.ownerName}{conflict.ownerOnline ? "（接続中）" : "（切断）"}
              </p>
              <p className="mt-0.5 break-all font-mono text-xs text-muted">
                {conflict.paths.length > 0 ? conflict.paths.join(", ") : "パス不明"}
              </p>
              {projectId ? (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  className="mt-2"
                  busy={busyLeaseId === conflict.leaseId}
                  onClick={() => void discardLease(conflict.leaseId)}
                >
                  予約を解除
                </Button>
              ) : (
                <p className="mt-2 text-xs text-muted">プロジェクトを選ぶか、サイドバーの「競合」を押すと予約を解除できます。</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

export function CollaborationBadge({
  projectId,
  room,
  className,
  onResolved,
}: {
  projectId?: string | null;
  room: CollaborationRoomSummary | undefined;
  className?: string;
  onResolved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const attention = Boolean(room && (room.leaseConflicts > 0 || room.pendingAsks > 0 || !room.ready));

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!room) return null;
  const accessibleLabel = collaborationLabel(room);

  return (
    <>
      <button
        type="button"
        title={[accessibleLabel, attention ? "クリックして詳細を開く" : ""].filter(Boolean).join("。")}
        aria-label={accessibleLabel}
        aria-expanded={attention ? open : undefined}
        aria-haspopup={attention ? "dialog" : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (attention) setOpen(true);
        }}
        className={cx(
          "inline-flex shrink-0 items-center gap-1 rounded-full font-medium",
          attention ? "px-2 py-0.5 text-xs" : "px-1.5 py-0.5 text-[10px]",
          !room.ready ? "bg-surface-2 text-muted" : attention ? "bg-warning-bg text-warning" : "bg-surface-2 text-muted",
          attention && "cursor-pointer hover:ring-1 hover:ring-warning/50",
          className,
        )}
      >
        <Users aria-hidden="true" className={attention ? "h-3.5 w-3.5" : "h-3 w-3"} />
        <span className="tabular-nums">{room.peers}</span>
        {room.leaseConflicts > 0 && (
          <>
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 text-danger" />
            <span>競合{room.leaseConflicts}件</span>
          </>
        )}
        {room.pendingAsks > 0 && <MessageCircle aria-hidden="true" className="h-3.5 w-3.5 text-accent" />}
      </button>
      {open && attention && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-md rounded-xl border border-border bg-surface p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 id={titleId} className="text-sm font-semibold">
                協調セッションの状態
              </h2>
              <Button type="button" variant="ghost" size="icon" aria-label="閉じる" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <CollaborationNotice
              projectId={projectId}
              room={room}
              onResolved={() => {
                onResolved?.();
                setOpen(false);
              }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
