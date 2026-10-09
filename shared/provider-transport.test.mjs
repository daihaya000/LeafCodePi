import assert from "node:assert/strict";
import test from "node:test";
import { isProviderTransportError, providerTransportRetryDelayMs } from "./provider-transport.mjs";

test("matches provider transport interruptions without widening terminal failures", () => {
  for (const value of ["terminated", "TypeError: terminated", "Error: terminated", "fetch failed", "read ECONNRESET", "UND_ERR_SOCKET", "socket hang up", "other side closed", "WebSocket closed", "stream ended before a terminal response event"]) {
    assert.equal(isProviderTransportError(value), true, value);
  }
  for (const value of ["Request was aborted", "This operation was aborted", "401 unauthorized", "403 forbidden", "invalid api key", "usage limit reached", "quota exceeded", "context length exceeded", "provider failed", "tool execution terminated", "process terminated", "Our servers are overloaded", "", null, {}, "fetch failed: Request was aborted", "network error: unauthorized"]) {
    assert.equal(isProviderTransportError(value), false, String(value));
  }
});

test("bounds transport recovery to five retries with exponential backoff", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(providerTransportRetryDelayMs), [5_000, 10_000, 20_000, 40_000, 60_000, null]);
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.equal(providerTransportRetryDelayMs(value), null);
});
