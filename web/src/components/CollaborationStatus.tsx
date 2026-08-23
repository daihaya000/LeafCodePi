"use client";

import { AlertTriangle, MessageCircle, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
      const response = await getJson<{ room: CollaborationRoomSummary }>(`/api/collaboration?projectId=${encodeURIComponent(projectId)}`);
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
        const response = await getJson<{ room: CollaborationRoomSummary }>(`/api/collaboration?projectId=${encodeURIComponent(projectId)}`);
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

export function CollaborationBadge({ room, className }: { room: CollaborationRoomSummary | undefined; className?: string }) {
  if (!room) return null;
  const attention = room.leaseConflicts > 0 || room.pendingAsks > 0;
  const label = [
    `${room.peers}セッション接続中`,
    room.leaseConflicts > 0 ? `競合${room.leaseConflicts}件` : "",
    room.pendingAsks > 0 ? `未処理ask${room.pendingAsks}件` : "",
    !room.ready ? "room状態を確認できません" : "",
  ].filter(Boolean).join("、");
  const sessionNames = room.sessionNames.length > 0
    ? `接続中のセッション: ${room.sessionNames.join("、")}`
    : "";
  const accessibleLabel = [label, sessionNames].filter(Boolean).join("、");
  return (
    <span
      title={[
        accessibleLabel,
        room.leaseConflicts > 0 ? "タスク画面の警告から予約を解除できます" : "",
        room.reason,
      ].filter(Boolean).join("。")}
      aria-label={accessibleLabel}
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
        room.leaseConflicts > 0 ? `lease競合 ${room.leaseConflicts}件` : "",
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
        "flex flex-col gap-2 rounded-lg border px-3 py-2 text-xs",
        room.ready ? "border-warning/30 bg-warning-bg text-warning" : "border-border bg-surface-2 text-muted",
      )}
    >
      <div role="status" className="flex items-start gap-2">
        {room.ready ? <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Users aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 space-y-1">
          <p className="break-words">{summary}</p>
          {room.leaseConflicts > 0 && (
            <p className="text-[11px] text-current/80">
              切れたセッションや外部変更で無効になったファイル予約です。他のセッションはそのパスを編集・commitできません。作業ツリーの変更は消えません。所有セッションを再開して予約を取り戻すか、不要なら予約だけ解除できます。
            </p>
          )}
          {room.pendingAsks > 0 && (
            <p className="text-[11px] text-current/80">
              未処理askは相手セッションが次に応答するまで残ります。こちらから強制解決はできません。
            </p>
          )}
        </div>
      </div>
      {conflicts.length > 0 && (
        <ul className="space-y-2">
          {conflicts.map((conflict) => (
            <li key={conflict.leaseId} className="rounded-md border border-current/15 bg-bg/40 px-2 py-2 text-text">
              <p className="font-medium">{conflictStateLabel(conflict.state)}</p>
              <p className="mt-0.5 text-[11px] text-muted">
                所有者: {conflict.ownerName}{conflict.ownerOnline ? "（接続中）" : "（切断）"}
              </p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-muted">
                {conflict.paths.length > 0 ? conflict.paths.join(", ") : "パス不明"}
              </p>
              {projectId && (
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
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}
