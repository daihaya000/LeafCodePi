"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type McpDto = {
  id: string;
  name: string;
  enabled: boolean;
  source: "stdio" | "http";
};

type McpResponse = {
  servers: McpDto[];
  configPath: string;
};

export function McpSettings() {
  const [servers, setServers] = useState<McpDto[]>([]);
  const [configPath, setConfigPath] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<McpResponse>("/api/mcp")
      .then((result) => {
        setServers(result.servers);
        setConfigPath(result.configPath);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "MCP サーバー一覧の取得に失敗しました");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(server: McpDto) {
    if (busyId) return;
    setBusyId(server.id);
    setError(null);
    try {
      const result = await sendJson<{ servers: McpDto[] }>(
        `/api/mcp/${encodeURIComponent(server.id)}`,
        { enabled: !server.enabled },
        "PATCH",
      );
      setServers(result.servers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MCP サーバーの切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">MCP サーバー</h2>
        <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyId)}>
          再読込
        </Button>
      </div>
      <p className="text-xs text-muted">
        leafcode-mcp-adapter が読む MCP サーバー設定（
        <span className="font-mono">~/.pi/agent/mcp.json</span>
        ）の有効／無効を切り替えます。追加は <span className="font-mono">.mcp.json</span> などに{" "}
        <span className="font-mono">mcpServers</span> を記述してください。
      </p>
      {configPath && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-faint">
          <p className="break-all">{configPath}</p>
        </div>
      )}
      {loading && servers.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : servers.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          MCP サーバーがありません。{" "}
          <span className="font-mono">.mcp.json</span> に mcpServers を追加してください。
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {servers.map((server) => (
            <li
              key={server.id}
              aria-busy={busyId === server.id || undefined}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-text" title={server.id}>
                    {server.name}
                  </p>
                  <Badge tone={server.source === "http" ? "warning" : "neutral"}>
                    {server.source}
                  </Badge>
                  <Badge tone={server.enabled ? "success" : "neutral"}>
                    {server.enabled ? "有効" : "無効"}
                  </Badge>
                </div>
              </div>
              <Switch
                checked={server.enabled}
                onChange={() => void toggle(server)}
                label={`${server.name} を${server.enabled ? "無効化" : "有効化"}`}
                busy={busyId === server.id}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
