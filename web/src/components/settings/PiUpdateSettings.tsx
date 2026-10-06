"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { HOST_LAUNCH_REQUIRED_HINT_ANY } from "@/lib/host-launch-hints";

type PiUpdateMode = "default" | "latest";

type PiUpdateRequest = {
  mode: PiUpdateMode;
  requestedAt: number | null;
};

type PiUpdateResult = {
  mode: PiUpdateMode;
  requestedAt: number | null;
  finishedAt: number | null;
  ok: boolean;
  updated: boolean;
  from: string | null;
  version: string | null;
  error: string | null;
};

type PiUpdateStatus = {
  defaultVersion: string;
  current: string | null;
  pending: PiUpdateRequest | null;
  last: PiUpdateResult | null;
};

function modeLabel(mode: PiUpdateMode, defaultVersion: string): string {
  return mode === "default" ? `既定バージョン v${defaultVersion} への再同期` : "最新版への更新";
}

function formatTime(value: number | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("ja-JP");
}

export function PiUpdateSettings() {
  const [status, setStatus] = useState<PiUpdateStatus | null>(null);
  const [hostReachable, setHostReachable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<PiUpdateMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<string | null>(null);
  const [publishedCheckedAt, setPublishedCheckedAt] = useState<number | null>(null);
  const [checkingPublishedVersion, setCheckingPublishedVersion] = useState(false);
  const [publishedVersionError, setPublishedVersionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pi/update", {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<PiUpdateStatus> & {
        error?: string;
        hint?: string;
      };
      if (!mountedRef.current) return;
      if (!res.ok) {
        // Only a connection failure shows the launch hint; an older Host answers but cannot reserve.
        const unreachable =
          typeof data.error === "string" && data.error.includes("接続できません");
        setHostReachable(!unreachable);
        setStatus(null);
        setError(
          unreachable
            ? null
            : [data.error, data.hint].filter(Boolean).join(" — ") ||
                "Piアップデートの状態を取得できません",
        );
        return;
      }
      setHostReachable(true);
      setStatus({
        defaultVersion: typeof data.defaultVersion === "string" ? data.defaultVersion : "?",
        current: typeof data.current === "string" ? data.current : null,
        pending: data.pending ?? null,
        last: data.last ?? null,
      });
      setError(null);
    } catch {
      if (!mountedRef.current) return;
      setHostReachable(false);
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const checkPublishedVersion = async () => {
    if (checkingPublishedVersion) return;
    setCheckingPublishedVersion(true);
    setPublishedVersionError(null);
    try {
      const res = await fetch("/api/pi/latest-version", {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        version?: unknown;
        checkedAt?: unknown;
        error?: string;
      };
      if (!res.ok || typeof data.version !== "string") {
        throw new Error(data.error || "Piの最新バージョンを取得できませんでした");
      }
      if (!mountedRef.current) return;
      setPublishedVersion(data.version);
      setPublishedCheckedAt(typeof data.checkedAt === "number" ? data.checkedAt : Date.now());
    } catch (err) {
      if (mountedRef.current) {
        setPublishedVersionError(
          err instanceof Error ? err.message : "Piの最新バージョンを取得できませんでした",
        );
      }
    } finally {
      if (mountedRef.current) setCheckingPublishedVersion(false);
    }
  };

  const reserve = async (mode: PiUpdateMode) => {
    if (busy) return;
    setBusy(mode);
    setError(null);
    try {
      const res = await fetch("/api/pi/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
      if (!res.ok && res.status !== 202) {
        throw new Error(
          [data.error, data.hint].filter(Boolean).join(" — ") || "更新を予約できませんでした",
        );
      }
      await load();
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "更新を予約できませんでした");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const ready = hostReachable === true && status !== null && busy === null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">Pi アップデート</h3>
      <p className="mt-1 text-xs text-muted">
        起動時の自動更新は行いません。ここで予約した内容は、次回のトレイホスト再起動時に適用されます。
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted">配信中の最新バージョン</p>
          <p className="text-sm">
            {publishedVersion
              ? `v${publishedVersion}`
              : checkingPublishedVersion
                ? "確認中…"
                : "未確認"}
          </p>
          {publishedCheckedAt !== null && (
            <p className="text-xs text-muted">最終確認: {formatTime(publishedCheckedAt)}</p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={checkingPublishedVersion}
          disabled={checkingPublishedVersion}
          onClick={() => void checkPublishedVersion()}
        >
          最新バージョンを確認
        </Button>
      </div>
      {publishedVersionError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {publishedVersionError}
        </p>
      )}
      {hostReachable === null && (
        <p className="mt-2 text-xs text-muted">ホストの状態を確認しています…</p>
      )}
      {hostReachable === false && (
        <p className="mt-2 text-xs text-muted">{HOST_LAUNCH_REQUIRED_HINT_ANY}</p>
      )}
      {hostReachable === true && status !== null && (
        <>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">現在のバージョン</dt>
            <dd>{status.current ? `v${status.current}` : "不明"}</dd>
            <dt className="text-muted">既定バージョン</dt>
            <dd>v{status.defaultVersion}</dd>
          </dl>
          {status?.pending && (
            <p className="mt-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
              予約済み: {modeLabel(status.pending.mode, status.defaultVersion)}（
              {formatTime(status.pending.requestedAt)}）。下の「再起動」からトレイホストを再起動すると反映されます。
            </p>
          )}
          {status?.last && (
            <p className="mt-2 text-xs text-muted">
              前回（{formatTime(status.last.finishedAt)}）:{" "}
              {modeLabel(status.last.mode, status.defaultVersion)}
              {status.last.from
                ? ` — v${status.last.from} → ${status.last.version ? `v${status.last.version}` : "変化なし"}`
                : ""}{" "}
              {status.last.ok
                ? status.last.updated
                  ? "成功"
                  : "変更なし"
                : `失敗: ${status.last.error ?? "原因不明"}`}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={busy === "default"}
          disabled={!ready}
          onClick={() => void reserve("default")}
        >
          既定バージョンに戻す
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={busy === "latest"}
          disabled={!ready}
          onClick={() => void reserve("latest")}
        >
          最新版に更新
        </Button>
      </div>
    </div>
  );
}
