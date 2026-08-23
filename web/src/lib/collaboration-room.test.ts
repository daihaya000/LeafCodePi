import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  connectRoom,
  normalizeSelector,
  selectorsOverlap,
  type RoomClient,
} from "../../../extensions/leafcode-collaboration/room";

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
  });
});

function mkdirAndWrite(root: string, relative: string, content: string): void {
  const filePath = join(root, relative);
  const directory = dirname(filePath);
  // The fixture has one small parent; avoiding a separate helper dependency keeps the test local.
  mkdirSync(directory, { recursive: true });
  writeFileSync(filePath, content, "utf8");
}
