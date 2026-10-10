
import { resolveHostControlUrl } from "@/lib/host-http-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(method: string, body?: unknown) {
  const init: RequestInit = {
    method,
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return fetch(`${resolveHostControlUrl()}/browser/config`, init);
}

async function response(res: Response) {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return Response.json(data, { status: res.ok ? 200 : res.status });
}

export async function GET() {
  try {
    return response(await forward("GET"));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? `ホストに接続できません: ${err.message}` : "ホストに接続できません" },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { autoOpenBrowser?: unknown } | null;
  if (typeof body?.autoOpenBrowser !== "boolean") {
    return Response.json({ error: "autoOpenBrowser must be a boolean" }, { status: 400 });
  }
  try {
    return response(await forward("POST", { autoOpenBrowser: body.autoOpenBrowser }));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? `ホストに接続できません: ${err.message}` : "ホストに接続できません" },
      { status: 502 },
    );
  }
}
