/** Client-safe loopback hostname checks (no node: imports). */

// 127.0.0.0/8 は全てループバック（127.0.0.1 以外もローカルホスト）。
// 各オクテットは 0-255 のみ許容（256 等は無効な IPv4）。
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_LOOPBACK_RE = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    IPV4_LOOPBACK_RE.test(host)
  );
}
