"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { HOST_LAUNCH_REQUIRED_HINT_ANY, HOST_RESTART_READY_HINT_ANY } from "@/lib/host-launch-hints";
import type { HealthDto } from "@/lib/types";
import { createBackendRestartCheck, type BackendRestartStatus } from "@/lib/host-restart-state";

import { RESTART_LABELS as LABELS, restartConfirmation, type RestartTarget } from "@/lib/host-restart-copy";

const HEALTH_BUDGET_MS = 300_000;
const HEALTH_INTERVAL_MS = 1_500;
const HEALTH_TIMEOUT_MS = 4_000;

async function timedFetch(input: string, init?: RequestInit & { timeoutMs?: number }) {
  const { timeoutMs = 10_000, ...rest } = init ?? {};
  return fetch(input, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function HostRestartPanel({ onRestarted }: { onRestarted?: () => void }) {
  const [hostOk, setHostOk] = useState<boolean | null>(null);
  const [pending, setPending] = useState<RestartTarget | null>(null);
  const [restarting, setRestarting] = useState<RestartTarget | null>(null);
  const [remaining, setRemaining] = useState(HEALTH_BUDGET_MS / 1000);
  const [error, setError] = useState<string | null>(null);
  const restartingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const res = await timedFetch("/api/llama-server/status", { timeoutMs: 3000 });
        if (!mountedRef.current) return;
        if (res.ok) {
          setHostOk(true);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
        const unreachable =
          typeof body.error === "string" && body.error.includes("接続できません");
        setHostOk(!unreachable);
      } catch {
        if (mountedRef.current) setHostOk(false);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const restartService = async (action: RestartTarget) => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setPending(null);
    setRestarting(action);
    setRemaining(HEALTH_BUDGET_MS / 1000);
    setError(null);
    try {
      let previousBackend: BackendRestartStatus | null = null;
      if (action === "backend") {
        try {
          const before = await timedFetch("/api/backend/status", { timeoutMs: HEALTH_TIMEOUT_MS });
          if (before.ok) previousBackend = await before.json() as BackendRestartStatus;
        } catch { /* Unknown state requires an observed outage before accepting readiness. */ }
      }
      const backendRestartCompleted = createBackendRestartCheck(previousBackend);
      const res = await timedFetch("/api/host/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: action }),
        timeoutMs: 10_000,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        hint?: string;
      };
      if (!res.ok && res.status !== 202) {
        throw new Error(
          [data.error, data.hint].filter(Boolean).join(" — ") || "再起動に失敗しました",
        );
      }
      // Host restart replaces the WebUI process too — show the reconnect overlay so the
      // page reloads onto the new build instead of sitting on a stale SPA after health returns.
      if (action === "webui" || action === "host") {
        window.dispatchEvent(
          new CustomEvent("leafcode:webui-restart", { detail: { target: action } }),
        );
      }
      if (action === "host") {
        // Overlay owns wait+reload; the dying page must not claim success via onRestarted.
        return;
      }
      const deadline = Date.now() + HEALTH_BUDGET_MS;
      let success = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
        if (!mountedRef.current) return;
        setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
        try {
          // A Backend restart leaves the WebUI up, so its readiness — not the WebUI's health — is
          // what the operator waits for.
          const h = await timedFetch(
            action === "backend" ? `/api/backend/status?restart=${Date.now()}` : `/api/health?restart=${Date.now()}`,
            { timeoutMs: HEALTH_TIMEOUT_MS },
          );
          if (!h.ok) continue;
          const body = (await h.json().catch(() => ({}))) as HealthDto & BackendRestartStatus;
          if (action === "backend") {
            if (backendRestartCompleted(body)) {
              success = true;
              break;
            }
            continue;
          }
          if (body && typeof body.engineOk === "boolean") {
            success = true;
            break;
          }
        } catch {
          // WebUI (or the Backend it depends on) may still be restarting.
        }
      }
      if (!success) {
        throw new Error(
          `${LABELS[action]}の再起動後、ヘルスチェックがタイムアウトしました。ページを再読み込みしてください。`,
        );
      }
      onRestarted?.();
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "再起動に失敗しました");
      }
    } finally {
      restartingRef.current = false;
      if (mountedRef.current) setRestarting(null);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">再起動</h3>
      <p className="mt-1 text-xs text-muted">
        {hostOk === null
          ? "接続を確認しています…"
          : hostOk === false
          ? HOST_LAUNCH_REQUIRED_HINT_ANY
          : HOST_RESTART_READY_HINT_ANY}
      </p>
      <p className="mt-1 text-xs text-muted">
        各再起動は最初に最新ソースを取得（git pull）してから再ビルド・再起動します。WebUI はフロントエンドのみ、バックエンドはバックエンドのみ、トレイホストは両方です。ビルド失敗時は前回のビルドで起動します。
      </p>
      <p className="mt-1 text-xs text-muted">
        WebUI の再起動ではセッションは継続します。バックエンド・トレイホストの再起動では実行中のセッションは終了します。
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={restarting === "webui"}
          disabled={hostOk !== true || restarting !== null}
          onClick={() => setPending("webui")}
        >
          WebUI を再起動
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={restarting === "backend"}
          disabled={hostOk !== true || restarting !== null}
          onClick={() => setPending("backend")}
        >
          バックエンド（Pi）を再起動
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={restarting === "host"}
          disabled={hostOk !== true || restarting !== null}
          onClick={() => setPending("host")}
        >
          トレイホストを再起動
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={restarting !== null}
          onClick={() => window.location.reload()}
        >
          ページ再読み込み
        </Button>
      </div>
      {pending && !restarting && (
        <div
          role="dialog"
          aria-live="polite"
          aria-label="再起動の確認"
          className="mt-3 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning"
        >
          <p className="font-medium">
            {restartConfirmation(pending)}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="primary" onClick={() => void restartService(pending)}>
              再起動する
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setPending(null)}>
              キャンセル
            </Button>
          </div>
        </div>
      )}
      <p className="mt-2 min-h-4 text-xs text-muted" role="status" aria-live="polite">
        {restarting ? (
          <>
            {`${LABELS[restarting]}を再起動しています…`}
            <span aria-hidden="true">{`（残り ${remaining} 秒）`}</span>
          </>
        ) : null}
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
