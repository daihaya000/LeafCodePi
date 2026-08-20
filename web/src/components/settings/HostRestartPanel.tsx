"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import type { HealthDto } from "@/lib/types";

type RestartTarget = "webui" | "host";

const LABELS: Record<RestartTarget, string> = {
  webui: "WebUI",
  host: "トレイホスト",
};

const HEALTH_BUDGET_MS = 90_000;
const HEALTH_INTERVAL_MS = 1_500;
const HEALTH_TIMEOUT_MS = 4_000;

async function timedFetch(input: string, init?: RequestInit & { timeoutMs?: number }) {
  const timeoutMs = init?.timeoutMs ?? 10_000;
  const { timeoutMs: _ignored, ...rest } = init ?? {};
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

  const restartService = async (target: RestartTarget) => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setPending(null);
    setRestarting(target);
    setRemaining(HEALTH_BUDGET_MS / 1000);
    setError(null);
    try {
      const res = await timedFetch("/api/host/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
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
      const deadline = Date.now() + HEALTH_BUDGET_MS;
      let success = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
        if (!mountedRef.current) return;
        setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
        try {
          const h = await timedFetch(`/api/health?restart=${Date.now()}`, {
            timeoutMs: HEALTH_TIMEOUT_MS,
          });
          if (!h.ok) continue;
          const body = (await h.json().catch(() => ({}))) as HealthDto;
          if (body && typeof body.engineOk === "boolean") {
            success = true;
            break;
          }
        } catch {
          // WebUI may still be restarting.
        }
      }
      if (!success) {
        throw new Error(
          `${LABELS[target]}の再起動後、ヘルスチェックがタイムアウトしました。ページを再読み込みしてください。`,
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
      <h2 className="text-sm font-semibold">再起動</h2>
      <p className="mt-1 text-xs text-muted">
        {hostOk === false
          ? "start.bat（トレイホスト）経由の起動が必要です。"
          : "トレイメニューの Restart WebUI と同じ操作です。"}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={restarting === "webui"}
          disabled={hostOk === false || restarting !== null}
          onClick={() => setPending("webui")}
        >
          WebUI を再起動
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          busy={restarting === "host"}
          disabled={hostOk === false || restarting !== null}
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
          <p className="font-medium">{LABELS[pending]}を再起動しますか？</p>
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
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
