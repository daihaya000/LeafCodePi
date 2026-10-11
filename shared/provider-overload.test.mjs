import assert from "node:assert/strict";
import test from "node:test";
import { isProviderOverloadError, providerOverloadRetryDelayMs } from "./provider-overload.mjs";

test("recognizes Codex overload without retrying quota/auth/context/abort failures", () => {
  for (const error of [
    "Codex error: Our servers are currently overloaded. Please try again later.",
    "Our servers are overloaded. Please try again later.",
    "overloaded_error", "server_overloaded", "Server overload", "Model is overloaded",
  ]) assert.equal(isProviderOverloadError(error), true, error);
  for (const error of [
    "usage limit reached", "429 rate limit exceeded", "401 unauthorized",
    "context length exceeded", "Request was aborted", "provider failed",
    "Please try again later.", "", null, {},
  ]) assert.equal(isProviderOverloadError(error), false, String(error));
});

test("backs off from 30 seconds to at most 5 minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(providerOverloadRetryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
});
