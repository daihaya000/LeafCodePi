/** ネイティブダイアログはホスト PC の画面に開く。リモートからは要求しない。 */
export function isWindowsClient(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return [nav.userAgentData?.platform, navigator.platform, navigator.userAgent]
    .filter((v): v is string => typeof v === "string")
    .some((v) => /win/i.test(v));
}

/** WebUI をホスト PC 自身（loopback）で開いているか。 */
export function isLoopbackClientUrl(): boolean {
  if (typeof location === "undefined") return false;
  const hostname = location.hostname.toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}
