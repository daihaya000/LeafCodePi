import { NextResponse } from "next/server";
import {
  hostLlamaServerPath,
  resolveHostControlUrl,
  type HostLlamaServerAction,
} from "@/lib/host-control";
import {
  isSafeLlamaModelFile,
  isSafeLlamaPathValue,
  LLAMA_SERVER_EFFORTS,
  LLAMA_SERVER_HOSTS,
  resolveLlamaServerBin,
  type LlamaServerEffort,
  type LlamaServerHost,
} from "@/lib/llama-server-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set<HostLlamaServerAction>(["status", "start", "stop"]);

type StartBody = {
  effort?: LlamaServerEffort;
  contextLength?: number;
  parallel?: number;
  llamaServerBin?: string;
  modelDir?: string;
  modelFile?: string;
  llamaServerHost?: LlamaServerHost;
};

function parseAction(raw: string): HostLlamaServerAction | null {
  return ACTIONS.has(raw as HostLlamaServerAction) ? (raw as HostLlamaServerAction) : null;
}

function parseStartBody(value: unknown): StartBody | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const config: StartBody = {};
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== "string" || !LLAMA_SERVER_EFFORTS.includes(raw.effort as LlamaServerEffort)) {
      return null;
    }
    config.effort = raw.effort as LlamaServerEffort;
  }
  if (raw.contextLength !== undefined) {
    if (
      typeof raw.contextLength !== "number" ||
      !Number.isSafeInteger(raw.contextLength) ||
      raw.contextLength < 4096 ||
      raw.contextLength > 1_000_000
    ) {
      return null;
    }
    config.contextLength = raw.contextLength;
  }
  if (raw.parallel !== undefined) {
    if (
      typeof raw.parallel !== "number" ||
      !Number.isSafeInteger(raw.parallel) ||
      raw.parallel < 1 ||
      raw.parallel > 16
    ) {
      return null;
    }
    config.parallel = raw.parallel;
  }
  if (raw.llamaCppPath !== undefined) {
    if (!isSafeLlamaPathValue(raw.llamaCppPath)) return null;
    const bin = resolveLlamaServerBin(raw.llamaCppPath);
    if (bin) config.llamaServerBin = bin;
  }
  if (raw.modelDir !== undefined) {
    if (!isSafeLlamaPathValue(raw.modelDir)) return null;
    const modelDir = raw.modelDir.trim();
    if (modelDir) config.modelDir = modelDir;
  }
  if (raw.modelFile !== undefined) {
    if (!isSafeLlamaModelFile(raw.modelFile)) return null;
    const modelFile = raw.modelFile.trim();
    if (modelFile) config.modelFile = modelFile;
  }
  if (raw.llamaServerHost !== undefined) {
    if (
      typeof raw.llamaServerHost !== "string" ||
      !LLAMA_SERVER_HOSTS.includes(raw.llamaServerHost as LlamaServerHost)
    ) {
      return null;
    }
    config.llamaServerHost = raw.llamaServerHost as LlamaServerHost;
  }
  if (config.modelFile !== undefined && config.modelDir === undefined) return null;
  return config;
}

async function forward(action: HostLlamaServerAction, body?: StartBody) {
  const base = resolveHostControlUrl();
  const hasBody = body !== undefined;
  try {
    const res = await fetch(`${base}${hostLlamaServerPath(action)}`, {
      method: action === "status" ? "GET" : "POST",
      headers: hasBody ? { "content-type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(action === "status" ? 3000 : 5000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            typeof data.error === "string" ? data.error : `host control failed: ${res.status}`,
          ...data,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `llama-server 制御に接続できません: ${err.message}`
            : "llama-server 制御に接続できません",
        hint: "start.bat（トレイホスト）が起動しているか確認してください",
      },
      { status: 502 },
    );
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ action: string }> }) {
  const action = parseAction((await params).action);
  if (action !== "status") {
    return NextResponse.json({ error: "GET supports status only" }, { status: 405 });
  }
  return forward(action);
}

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const action = parseAction((await params).action);
  if (action !== "start" && action !== "stop") {
    return NextResponse.json({ error: "POST supports start or stop only" }, { status: 405 });
  }
  if (action === "stop") return forward(action, {});
  const body = parseStartBody(await req.json().catch(() => ({})));
  if (body === null) {
    return NextResponse.json({ error: "invalid llama-server start settings" }, { status: 400 });
  }
  return forward(action, body);
}
