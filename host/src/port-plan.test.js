import assert from "node:assert/strict";
import test from "node:test";
import { parseListeningPids, parseLsofListeningPids, parseSsListeningPids } from "./port-plan.js";

test("parseListeningPids reads Windows TCP listeners", () => {
  const output = "  TCP    127.0.0.1:3010   0.0.0.0:0   LISTENING   1234\n";
  assert.deepEqual(parseListeningPids(output, 3010), [1234]);
});

test("parseSsListeningPids reads Linux TCP listeners", () => {
  const output = [
    "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    'LISTEN 0      511    127.0.0.1:3010    0.0.0.0:*    users:(("node",pid=4321,fd=20))',
    'LISTEN 0      128    127.0.0.1:30100   0.0.0.0:*    users:(("other",pid=9999,fd=3))',
    'LISTEN 0      128    [::1]:3010        [::]:*       users:(("node",pid=4321,fd=21))',
  ].join("\n");
  assert.deepEqual(parseSsListeningPids(output, 3010), [4321]);
});

test("parseLsofListeningPids deduplicates numeric PIDs", () => {
  assert.deepEqual(parseLsofListeningPids("4321\n4321\n\n9000\n", 3010), [4321, 9000]);
});
