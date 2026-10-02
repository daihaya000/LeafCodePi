import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMcpEnvCommands } from "./mcp-native-env-commands.mjs";

const safe = (error) => error instanceof Error && error.message === "MCP env command resolution unavailable" && error.cause === undefined;
const snapshot = (config) => ({ servers: [{ name: "fixture", source: "C:/agent/mcp.json", scope: "global", config }], errors: [] });

test("resolves command values through the injected executor and unescapes `!!`", () => {
  const input = snapshot({ command: "server.exe", env: { KEY: "!print-key", ESCAPED: "!!literal", PLAIN: "value", TEMPLATE: "${OTHER}" }, headers: { Authorization: "!print-header" } });
  const before = structuredClone(input);
  const commands = [];
  const resolved = resolveMcpEnvCommands(input, { run: (command) => { commands.push(command); return command === "print-key" ? "private-resolved\n" : "header-value"; } });
  assert.deepEqual(commands, ["print-key", "print-header"]);
  assert.deepEqual(resolved.servers[0].config.env, { KEY: "private-resolved\n", ESCAPED: "!literal", PLAIN: "value", TEMPLATE: "${OTHER}" });
  assert.deepEqual(resolved.servers[0].config.headers, { Authorization: "header-value" });
  assert.deepEqual(input, before, "the caller's snapshot must not be mutated");
});

test("failures, throws, empty output and timeouts keep the marker so only that server is refused", () => {
  for (const run of [() => undefined, () => { throw Error("private command failure"); }, () => "", () => null, () => 42]) {
    const resolved = resolveMcpEnvCommands(snapshot({ command: "server.exe", env: { KEY: "!print-key" } }), { run });
    assert.deepEqual(resolved.servers[0].config.env, { KEY: "!print-key" });
  }
});

test("the executor is required and malformed snapshots refuse without leaking details", () => {
  for (const options of [{}, { run: "spawn" }, { run: () => "x", extra: true }]) {
    assert.throws(() => resolveMcpEnvCommands(snapshot({ command: "server.exe" }), options), safe);
  }
  for (const bad of [undefined, [], { servers: "nope" }, { servers: [null] }, { servers: [{ name: "x", config: [] }] },
    { servers: [{ name: "x", config: { env: [] } }] }, { servers: [{ name: "x", config: { env: { KEY: 1 } } }] },
    { servers: [{ name: "x", config: { headers: { A: null } } }] }]) {
    assert.throws(() => resolveMcpEnvCommands(bad, { run: () => "x" }), safe);
  }
  try { resolveMcpEnvCommands(snapshot({ command: "server.exe", env: { KEY: "!secret-command" } }), { run: () => { throw Error("private secret output"); } }); }
  catch (error) { assert.equal(JSON.stringify(error.message).includes("secret"), false); }
});

test("a snapshot without env/headers is returned as a copy", () => {
  const input = snapshot({ command: "server.exe", args: ["--flag"] });
  const resolved = resolveMcpEnvCommands(input, { run: () => "unused" });
  assert.notEqual(resolved, input);
  assert.deepEqual(resolved, input);
});
