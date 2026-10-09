import { ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse, isConfigurationRequestAuthorized as isWebUiRequestAuthorized } from "../../configuration/http";

export const transferNoStore = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };

/** File transfers require loopback access or the WebUI access gate, including reads. */
export function rejectUnauthorizedTransfer(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return NextResponse.json({ error: "許可されない接続元です" }, { status: 403, headers: transferNoStore });
  }
  const loopbackHosts = ["127.0.0.1", "localhost", "::1", "[::1]"];
  const hostHeader = req.headers.get("host");
  let headerHost = "";
  try {
    const authority = hostHeader ? new URL(`http://${hostHeader}`) : new URL(req.url);
    if (!authority.username && !authority.password) headerHost = authority.hostname;
  } catch { /* malformed Host is not loopback */ }
  const localOnly = loopbackHosts.includes(process.env.LEAFCODE_PI_BIND_HOST ?? "") &&
    loopbackHosts.includes(new URL(req.url).hostname) && loopbackHosts.includes(headerHost);
  if (!localOnly && !isWebUiRequestAuthorized(req)) {
    return NextResponse.json({ error: "設定の転送にはローカル接続またはWebUIアクセスゲートが必要です" }, { status: 403, headers: transferNoStore });
  }
  return null;
}
