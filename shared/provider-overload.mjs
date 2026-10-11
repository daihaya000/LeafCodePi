/** Only transient capacity failures; usage limits/auth/context errors have other owners. */
export function isProviderOverloadError(value) {
  if (typeof value !== "string") return false;
  return /\b(?:servers? (?:are |is )?(?:currently )?overloaded|overloaded_error|server_overloaded|server overload|model (?:is )?overloaded)\b/i.test(value);
}

/** Keep retrying while overloaded, without hammering the provider (30s -> 5m). */
export function providerOverloadRetryDelayMs(attempt = 1) {
  return Math.min(300_000, 30_000 * 2 ** Math.min(4, Math.max(0, attempt - 1)));
}
