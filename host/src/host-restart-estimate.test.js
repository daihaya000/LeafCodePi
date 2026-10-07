import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateHostRestart, readHostRestartEstimate } from "./host-restart-estimate.js";

const now = Date.parse("2026-10-07T08:00:00Z");
const line = (ts, message, source = "host", level = "log") =>
  `${new Date(ts).toISOString()}\t${source}\t${level}\t${message}\n`;
const request = (ts) => line(ts, "Host restart requested; spawning replacement…");
const ready = (ts) => line(ts, "LeafCodePi is ready");
const sample = (ts, duration) => request(ts) + line(ts + 1000, "LeafCodePi host 1 pid=123") + ready(ts + duration);

test("learns the recent median instead of always returning five minutes", () => {
  const logs = [
    sample(now - 500_000, 210_000),
    sample(now - 350_000, 100_733),
    sample(now - 250_000, 95_352),
    sample(now - 150_000, 95_061),
  ];
  assert.deepEqual(estimateHostRestart(logs, now), { estimateMs: 99_000, estimateSamples: 4 });
});

test("uses only the five latest completions and resists a slow-build outlier", () => {
  const logs = Array.from({ length: 9 }, (_, i) => sample(now - (10 - i) * 1_000_000, i < 4 ? 300_000 : 90_000));
  logs.push(sample(now - 700_000, 600_000));
  assert.deepEqual(estimateHostRestart(logs, now), { estimateMs: 90_000, estimateSamples: 5 });
});

test("ignores failures, unfinished requests, other services, recovery, and invalid times", () => {
  const logs = [
    ready(now - 1_000_000), // ordinary startup
    request(now - 990_000) + ready(now - 980_000), // old host, no observed replacement
    request(now - 900_000) + line(now - 899_000, "Host restart failed: launch", "host", "error") + ready(now - 800_000),
    sample(now - 33 * 24 * 60 * 60_000, 90_000), // stale
    sample(now + 1000, 90_000), // future
    sample(now - 2_000_000, 1_000_000), // unreasonably long
    sample(now - 700_000, 1000), // unreasonably short
    request(now - 600_000) + line(now - 599_000, "LeafCodePi host 1 pid=1") + line(now - 598_000, "LeafCodePi host 1 pid=2") + ready(now - 500_000),
    line(now - 400_000, "Host restart requested; spawning replacement…", "build") + ready(now - 300_000),
    "bad\thost\tlog\tHost restart requested; spawning replacement…\n",
    sample(now - 200_000, 90_000),
    request(now - 50_000),
  ];
  assert.deepEqual(estimateHostRestart(logs, now), { estimateMs: 90_000, estimateSamples: 1 });
  assert.deepEqual(estimateHostRestart([], now), { estimateMs: 300_000, estimateSamples: 0 });
});

test("reads a completion across log rotation without requiring browser-local history", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-restart-estimate-"));
  try {
    assert.deepEqual(readHostRestartEstimate(dir, now), { estimateMs: 300_000, estimateSamples: 0 });
    writeFileSync(join(dir, "host.log.1"), request(now - 90_000), "utf8");
    writeFileSync(join(dir, "host.log"), line(now - 85_000, "LeafCodePi host 1 pid=123") + ready(now), "utf8");
    assert.deepEqual(readHostRestartEstimate(dir, now), { estimateMs: 90_000, estimateSamples: 1 });
    writeFileSync(join(dir, "host.log"), Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.deepEqual(readHostRestartEstimate(dir, now), { estimateMs: 300_000, estimateSamples: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
