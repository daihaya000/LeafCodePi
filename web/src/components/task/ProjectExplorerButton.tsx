"use client";

import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { isLoopbackHost } from "@/lib/loopback";

const LOCAL_CLIENT_HEADER = "x-leafcode-pi-local-client";
const DISCOVERY_TIMEOUT_MS = 1_500;

type ExplorerTarget = {
  controlUrl: string;
  path: string;
};

function loopbackControlUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !isLoopbackHost(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function discoverExplorerTarget(
  projectId: string,
  signal?: AbortSignal,
): Promise<ExplorerTarget | null> {
  try {
    const bootstrap = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/explorer`,
      { cache: "no-store", signal },
    );
    if (!bootstrap.ok) return null;
    const data = (await bootstrap.json()) as { controlUrl?: unknown; path?: unknown };
    const controlUrl = loopbackControlUrl(data.controlUrl);
    if (!controlUrl || typeof data.path !== "string" || !data.path.trim()) return null;

    const capabilities = await fetch(`${controlUrl}/local-client/capabilities`, {
      cache: "no-store",
      credentials: "omit",
      headers: { [LOCAL_CLIENT_HEADER]: "1" },
      mode: "cors",
      redirect: "error",
      signal,
    });
    if (!capabilities.ok) return null;
    const body = (await capabilities.json()) as { explorer?: unknown };
    return body.explorer === true ? { controlUrl, path: data.path } : null;
  } catch {
    return null;
  }
}

export async function openExplorer(target: ExplorerTarget): Promise<void> {
  const response = await fetch(`${target.controlUrl}/local-client/explorer`, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      [LOCAL_CLIENT_HEADER]: "1",
    },
    mode: "cors",
    redirect: "error",
    body: JSON.stringify({ path: target.path }),
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error || "プロジェクトを開けませんでした");
}

export function ProjectExplorerButton({
  projectId,
  onError,
}: {
  projectId?: string | null;
  onError: (message: string) => void;
}) {
  const [target, setTarget] = useState<ExplorerTarget | null>(null);

  useEffect(() => {
    setTarget(null);
    if (!projectId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    void discoverExplorerTarget(projectId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setTarget(next);
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId]);

  if (!target) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      title="プロジェクトをエクスプローラーで開く"
      aria-label="プロジェクトをエクスプローラーで開く"
      className="h-11 w-11 @min-[48rem]/task:h-9 @min-[48rem]/task:w-9"
      onClick={() => {
        void openExplorer(target).catch((error) => {
          onError(error instanceof Error ? error.message : "プロジェクトを開けませんでした");
        });
      }}
    >
      <FolderOpen className="h-4 w-4" />
    </Button>
  );
}
