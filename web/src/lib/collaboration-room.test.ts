import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore The standalone production mirror does not include extension sources; Vitest runs from the repository.
import { connectRoom, normalizeSelector, resolveProjectIdentity, selectorsOverlap, type ActivityEntry, type RoomClient } from "../../../extensions/leafcode-collaboration/room";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

describe("LeafCode room selectors", () => {
  it("allows exact and trailing-prefix selectors only", () => {
    assert.equal(normalizeSelector("src\\leaf.ts"), "src/leaf.ts");
    assert.equal(normalizeSelector("src/**"), "src/**");
    assert.equal(selectorsOverlap("src/**", "src/leaf.ts"), true);
    assert.equal(selectorsOverlap("src/a.ts", "src/b.ts"), false);
    assert.throws(() => normalizeSelector("../outside"), /traversal|invalid|selector/i);
    assert.throws(() => normalizeSelector("src/*.ts"), /exact|selector/i);
    assert.throws(() => normalizeSelector(".env"), /Protected/i);
  });
});

describe("LeafCode room coordinator", () => {
  let repo = "";
  let dataDir = "";
  const clients: RoomClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0).reverse()) await client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    repo = "";
    dataDir = "";
  });

  it("joins two sessions, preserves the lock, and gates mutations by lease", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    mkdirAndWrite(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, ["add", "src/a.ts", "src/b.ts"]);
    git(repo, ["commit", "-m", "initial"]);

    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const first = await connectRoom(repo, { sessionId: "session-a", displayName: "A", pid: process.pid }, env);
    clients.push(first);
    const second = await connectRoom(repo, { sessionId: "session-b", displayName: "B", pid: process.pid }, env);
    clients.push(second);

    assert.equal(first.ready, true);
    assert.equal(second.ready, true);
    assert.equal(existsSync(first.identity.lockPath), true);
    const current = await second.snapshot();
    assert.equal(current.sessions["session-a"]?.state, "active");
    assert.equal(current.sessions["session-b"]?.state, "active");

    const lease = await first.reserve(["src/a.ts"]);
    await assert.rejects(() => second.reserve(["src/a.ts"]), /overlap|another active|conflict/i);
    await assert.rejects(() => second.write("src/a.ts", "export const a = 2;\n"), /lease/i);

    const concurrent = await Promise.allSettled([first.reserve(["src/b.ts"]), second.reserve(["src/b.ts"])]);
    assert.equal(concurrent.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((attempt) => attempt.status === "rejected").length, 1);

    await first.write("src/a.ts", "export const a = 2;\n");
    assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const a = 2;\n");
    await first.edit("src/a.ts", "2", "3");
    assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const a = 3;\n");
    writeFileSync(join(repo, "src/a.ts"), "export const a = 99;\n", "utf8");
    await assert.rejects(() => first.write("src/a.ts", "export const a = 4;\n"), /foreign|changed/i);
    await assert.rejects(() => first.release(lease.id), /dirty|release/i);

    await first.reserve(["src/new/nested.ts"]);
    await first.write("src/new/nested.ts", "export const nested = true;\n");
    assert.equal(readFileSync(join(repo, "src/new/nested.ts"), "utf8"), "export const nested = true;\n");
  });

  it("takes over a lock immediately when its coordinator process is gone", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);

    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const identity = await resolveProjectIdentity(repo, env);
    mkdirSync(identity.roomDir, { recursive: true });
    writeFileSync(
      identity.lockPath,
      JSON.stringify({
        schema: 1,
        pid: 2_147_483_647,
        connectionId: "dead-coordinator",
        epoch: 1,
        heartbeatAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const client = await connectRoom(repo, { sessionId: "session-stale-lock", displayName: "Stale", pid: process.pid }, env);
    clients.push(client);
    assert.equal(client.ready, true);
  });

  it("clears an offline Git-change quarantine after the new baseline stays stable", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);

    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const first = await connectRoom(repo, { sessionId: "session-before-restart", pid: process.pid }, env);
    clients.push(first);
    await first.close();
    mkdirAndWrite(repo, "src/a.ts", "export const a = 2;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "offline change"]);
    writeFileSync(first.identity.lockPath, JSON.stringify({
      schema: 1,
      pid: 2_147_483_647,
      connectionId: "dead-coordinator",
      epoch: 1,
      heartbeatAt: new Date().toISOString(),
    }), "utf8");

    const quarantined = await connectRoom(repo, { sessionId: "session-after-crash", pid: process.pid }, env);
    clients.push(quarantined);
    assert.match((await quarantined.snapshot()).compromised?.reason ?? "", /offline/i);
    await quarantined.close();
    writeFileSync(first.identity.lockPath, JSON.stringify({
      schema: 1,
      pid: 2_147_483_647,
      connectionId: "second-dead-coordinator",
      epoch: 2,
      heartbeatAt: new Date().toISOString(),
    }), "utf8");

    const recovered = await connectRoom(repo, { sessionId: "session-after-stable-restart", pid: process.pid }, env);
    clients.push(recovered);
    assert.equal((await recovered.snapshot()).compromised, undefined);
  });

  it("runs a fixed check and commits only the selected lease paths", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    mkdirAndWrite(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, ["add", "src/a.ts", "src/b.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({
      mode: "strict",
      checks: { test: { file: process.execPath, args: ["-e", "process.stdout.write('check-ok')"] } },
    }), "utf8");

    const client = await connectRoom(repo, { sessionId: "session-check", displayName: "Check", pid: process.pid }, { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    clients.push(client);
    const peer = await connectRoom(repo, { sessionId: "session-peer", displayName: "Peer", pid: process.pid }, { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    clients.push(peer);
    await client.reserve(["src/a.ts"]);
    await client.write("src/a.ts", "export const a = 2;\n");
    await peer.reserve(["src/b.ts"]);
    await peer.write("src/b.ts", "export const b = 2;\n");

    const check = await client.check("test");
    assert.equal(check.code, 0);
    assert.equal(check.stdout, "check-ok");
    const commit = await client.commit("update a", ["src/a.ts"]);
    assert.equal(commit.paths.includes("src/a.ts"), true);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim(), commit.oid);
    assert.equal(execFileSync("git", ["show", "HEAD:src/b.ts"], { cwd: repo, encoding: "utf8", windowsHide: true }), "export const b = 1;\n");
    assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8", windowsHide: true }), /src\/b\.ts/);
  });

  it("fails closed when a check moves HEAD", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({
      mode: "strict",
      checks: {
        test: {
          file: process.execPath,
          args: ["-e", "require('node:child_process').execFileSync('git',['commit','--allow-empty','-m','check'],{stdio:'ignore'})"],
        },
      },
    }), "utf8");

    const client = await connectRoom(repo, { sessionId: "session-compromised", displayName: "Compromised", pid: process.pid }, { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    clients.push(client);
    await assert.rejects(() => client.check("test"), /HEAD|refs|compromised/i);
    assert.match((await client.snapshot()).compromised?.reason ?? "", /HEAD|refs/i);
    await assert.rejects(() => client.reserve(["src/a.ts"]), /compromised|disabled/i);
    await client.close();
    const restarted = await connectRoom(repo, { sessionId: "session-still-compromised", pid: process.pid }, { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    clients.push(restarted);
    await assert.rejects(() => restarted.reserve(["src/a.ts"]), /compromised|disabled/i);
  });

  it("rejects a commit when another session has shared staged changes", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    mkdirAndWrite(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, ["add", "src/a.ts", "src/b.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const first = await connectRoom(repo, { sessionId: "session-staged-a", displayName: "A", pid: process.pid }, env);
    clients.push(first);
    const second = await connectRoom(repo, { sessionId: "session-staged-b", displayName: "B", pid: process.pid }, env);
    clients.push(second);
    await first.reserve(["src/a.ts"]);
    await first.write("src/a.ts", "export const a = 2;\n");
    await second.reserve(["src/b.ts"]);
    await second.write("src/b.ts", "export const b = 2;\n");
    git(repo, ["add", "src/b.ts"]);
    await assert.rejects(() => first.commit("update a", ["src/a.ts"]), /staged|foreign/i);
  });

  it("keeps a disconnected session lease orphaned", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const first = await connectRoom(repo, { sessionId: "session-orphan", displayName: "Old", pid: process.pid }, env);
    clients.push(first);
    const lease = await first.reserve(["src/a.ts"]);
    const reconnect = await connectRoom(repo, { sessionId: "session-orphan", displayName: "New", pid: process.pid }, env);
    clients.push(reconnect);
    assert.equal((await reconnect.snapshot()).leases[lease.id]?.state, "orphaned");
    await assert.rejects(() => reconnect.reserve(["src/a.ts"]), /overlap|orphaned|conflict/i);
  });

  it("runs and guards the configured Git hook", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const hookDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
    const marker = join(dataDir, "hook-ran");
    const hook = join(repo, hookDir, "pre-commit");
    writeFileSync(hook, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(77);\n`, { encoding: "utf8", mode: 0o700 });
    git(repo, ["config", "core.hooksPath", hookDir]);

    const client = await connectRoom(repo, { sessionId: "session-hook", displayName: "Hook", pid: process.pid }, { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    clients.push(client);
    await client.reserve(["src/a.ts"]);
    await client.write("src/a.ts", "export const a = 2;\n");
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
    let rejected = false;
    try { await client.commit("update a", ["src/a.ts"]); } catch { rejected = true; }
    assert.equal(rejected, true);
    assert.equal(existsSync(marker), true);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim(), before);
  });

  it("routes untrusted peer messages and ask replies in memory", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const first = await connectRoom(repo, { sessionId: "session-message-a", displayName: "A", pid: process.pid }, env);
    clients.push(first);
    const second = await connectRoom(repo, { sessionId: "session-message-b", displayName: "B", pid: process.pid }, env);
    clients.push(second);

    await assert.rejects(() => first.send("session-message-b", "x".repeat(65_537)), /invalid|large/i);
    const sent = await first.send("session-message-b", "secret peer message");
    assert.equal(sent.kind, "send");
    assert.equal((await second.inbox())[0]?.message, "secret peer message");
    assert.deepEqual(await second.inbox(), []);
    const ask = await first.ask("session-message-b", "please check this");
    const receivedAsk = (await second.inbox())[0];
    assert.equal(receivedAsk?.kind, "ask");
    assert.equal(receivedAsk?.requestId, ask.requestId);
    await assert.rejects(() => first.reply(ask.requestId, "not allowed"), /recipient|target/i);
    const reply = await second.reply(ask.requestId, "checked");
    assert.equal((await first.inbox())[0]?.message, reply.message);
    await assert.rejects(() => second.reply(ask.requestId, "duplicate"), /unknown|expired/i);

    const activity = (await first.snapshot()).activity;
    assert.deepEqual(activity.map((entry: ActivityEntry) => entry.kind).filter((kind: ActivityEntry["kind"]) => ["send", "ask", "reply"].includes(kind)), ["send", "ask", "reply"]);
    assert.equal(JSON.stringify(activity).includes("secret peer message"), false);
    await second.close();
    await assert.rejects(() => first.send("session-message-b", "offline messages are not queued"), /connected/i);
  });

  it("rate limits peer messages per sender", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const first = await connectRoom(repo, { sessionId: "session-rate-a", displayName: "A", pid: process.pid }, env);
    clients.push(first);
    const second = await connectRoom(repo, { sessionId: "session-rate-b", displayName: "B", pid: process.pid }, env);
    clients.push(second);
    for (let index = 0; index < 30; index += 1) await first.send("session-rate-b", `message-${index}`);
    await assert.rejects(() => first.send("session-rate-b", "message-31"), /rate/i);
  });

  it("expires asks without retaining an offline request", async () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-collab-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-collab-data-"));
    writeFileSync(join(dataDir, "collaboration.json"), JSON.stringify({ mode: "strict", askTimeoutMs: 1_000 }), "utf8");
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "leafcode@example.invalid"]);
    git(repo, ["config", "user.name", "LeafCode Test"]);
    mkdirAndWrite(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, ["add", "src/a.ts"]);
    git(repo, ["commit", "-m", "initial"]);
    const env = { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir };
    const first = await connectRoom(repo, { sessionId: "session-timeout-a", displayName: "A", pid: process.pid }, env);
    clients.push(first);
    const second = await connectRoom(repo, { sessionId: "session-timeout-b", displayName: "B", pid: process.pid }, env);
    clients.push(second);
    const ask = await first.ask("session-timeout-b", "this will expire");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    assert.deepEqual(await second.inbox(), []);
    await assert.rejects(() => second.reply(ask.requestId, "too late"), /unknown|expired/i);
  });

});

function mkdirAndWrite(root: string, relative: string, content: string): void {
  const filePath = join(root, relative);
  const directory = dirname(filePath);
  // The fixture has one small parent; avoiding a separate helper dependency keeps the test local.
  mkdirSync(directory, { recursive: true });
  writeFileSync(filePath, content, "utf8");
}
