/** Transport interruptions only; never retry explicit aborts, auth, quota or context failures. */
export function isProviderTransportError(value) {
  if (typeof value !== "string") return false;
  if (/\b(?:abort(?:ed)?|unauthorized|forbidden|invalid api key|usage limit|quota|billing|context (?:length|window)|maximum context)\b/i.test(value)) return false;
  return /(?:^|\n)\s*(?:(?:TypeError|Error):\s*)?terminated\s*$|\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b|\b(?:fetch failed|socket hang up|other side closed|network error|connection (?:reset|lost|closed)|websocket\s*(?:error|closed)|stream ended before a terminal response event)\b/i.test(value);
}

/** Five retries per interrupted run; cap both delay and sustained failure loops. */
export function providerTransportRetryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 5) return null;
  return Math.min(60_000, 5_000 * 2 ** (attempt - 1));
}
