"use client";

import { useEffect, useState } from "react";
import { ApiError, sendJson } from "@/lib/client";

type AdviceModel = {
  providerID: string;
  modelID: string;
};

type AdviceResponse = {
  advice: string;
  model?: AdviceModel;
};

type AdviceState =
  | { requestId: string; status: "loading" }
  | { requestId: string; status: "success"; advice: string; model?: AdviceModel }
  | { requestId: string; status: "missing" }
  | { requestId: string; status: "error" };

const adviceRequests = new Map<string, Promise<AdviceResponse>>();

function loadAdvice(taskId: string, requestId: string): Promise<AdviceResponse> {
  const key = `${taskId}:${requestId}`;
  const existing = adviceRequests.get(key);
  if (existing) return existing;

  const request = sendJson<AdviceResponse>(
    `/api/tasks/${taskId}/permission/advice`,
    { requestId },
    "POST",
    { timeoutMs: 35_000 },
  );
  adviceRequests.set(key, request);
  void request.then(
    () => {
      setTimeout(() => {
        if (adviceRequests.get(key) === request) adviceRequests.delete(key);
      }, 60_000);
    },
    () => {
      if (adviceRequests.get(key) === request) adviceRequests.delete(key);
    },
  );
  return request;
}

export function PermissionAdvice({
  taskId,
  requestId,
}: {
  taskId: string;
  requestId: string;
}) {
  const [state, setState] = useState<AdviceState>({ requestId, status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ requestId, status: "loading" });
    void loadAdvice(taskId, requestId)
      .then((result) => {
        if (!cancelled) {
          setState({ requestId, status: "success", advice: result.advice, model: result.model });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 400) {
          setState({ requestId, status: "missing" });
          return;
        }
        setState({ requestId, status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, taskId]);

  if (state.requestId !== requestId) return null;
  if (state.status === "loading") {
    return (
      <p role="status" aria-live="polite" className="mt-2 text-xs text-muted">
        第三者アドバイスを生成中…
      </p>
    );
  }
  if (state.status === "missing") {
    return (
      <p role="status" aria-live="polite" className="mt-2 text-xs text-muted">
        第三者アドバイスを表示するには、設定 → モデル → 生成モデルを選択してください。
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="status" aria-live="polite" className="mt-2 text-xs text-muted">
        第三者アドバイスを取得できませんでした。許可・拒否はこの画面から選択してください。
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-text" aria-live="polite">
      <p className="text-xs font-medium text-muted">第三者アドバイス</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{state.advice}</p>
      {state.model && (
        <p
          className="mt-2 truncate text-xs text-muted"
          title={`生成モデル: ${state.model.providerID}::${state.model.modelID}`}
        >
          生成モデル: <span className="font-mono">{state.model.modelID}</span>
        </p>
      )}
    </div>
  );
}
