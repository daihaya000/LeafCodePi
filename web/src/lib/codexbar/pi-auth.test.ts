import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  defaultPiAuthPath,
  piAuthPathFor,
  readPiOAuthTokens,
  writeBackPiOAuthTokens,
} from "./pi-auth";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.PI_CODING_AGENT_DIR;
});

function tempAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-piauth-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

describe("pi-auth paths", () => {
  it("resolves the default auth path from PI_CODING_AGENT_DIR", () => {
    const dir = tempAgentDir();
    assert.equal(defaultPiAuthPath(), join(dir, "auth.json"));
    assert.equal(piAuthPathFor("openai-codex"), join(dir, "auth.json"));
  });

  it("requires agentDir when an account is specified", () => {
    tempAgentDir();
    assert.throws(() => piAuthPathFor("openai-codex", { accountId: "acc-1" }));
    const agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-agentdir-"));
    dirs.push(agentDir);
    assert.equal(
      piAuthPathFor("openai-codex", { accountId: "acc-1", agentDir }),
      join(agentDir, "accounts", "acc-1", "auth.json"),
    );
  });
});

describe("readPiOAuthTokens", () => {
  it("returns null when the file or fields are missing", () => {
    tempAgentDir();
    // ファイル無し
    assert.equal(readPiOAuthTokens("openai-codex"), null);
    // provider エントリ無し / access 欠落
    writeFileSync(defaultPiAuthPath(), JSON.stringify({ anthropic: {} }), "utf8");
    assert.equal(readPiOAuthTokens("openai-codex"), null);
    assert.equal(readPiOAuthTokens("anthropic"), null);
  });

  it("reads a well-formed entry with field guards", () => {
    const dir = tempAgentDir();
    writeFileSync(
      defaultPiAuthPath(),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "acc",
          refresh: "ref",
          expires: Date.now() + 1000,
          accountId: "chatgpt-1",
        },
        cursor: { type: "oauth" },
      }),
      "utf8",
    );
    void dir;
    const codex = readPiOAuthTokens("openai-codex");
    assert.deepEqual(codex?.access, "acc");
    assert.equal(codex?.refresh, "ref");
    assert.equal(typeof codex?.expires, "number");
    // 対象外プロバイダーは読まない
    assert.equal(readPiOAuthTokens("anthropic"), null);
  });

  it("reads back tokens written by writeBackPiOAuthTokens", () => {
    tempAgentDir();
    writeBackPiOAuthTokens("anthropic", { access: "a1", refresh: "r1" });
    const tokens = readPiOAuthTokens("anthropic");
    assert.equal(tokens?.access, "a1");
    assert.equal(tokens?.refresh, "r1");
    assert.ok(typeof tokens?.expires === "number");
  });
});

describe("writeBackPiOAuthTokens", () => {
  it("merges without dropping sibling providers or unknown keys", () => {
    const dir = tempAgentDir();
    const path = defaultPiAuthPath();
    writeFileSync(
      path,
      JSON.stringify({ customKey: { keep: true }, openai: { type: "api_key" } }),
      "utf8",
    );
    void dir;

    writeBackPiOAuthTokens("openai-codex", { access: "c1", refresh: "cr1" });
    writeBackPiOAuthTokens("anthropic", { access: "a1" });

    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      customKey?: unknown;
      openai?: unknown;
      "openai-codex"?: Record<string, unknown>;
      anthropic?: Record<string, unknown>;
    };
    assert.deepEqual(raw.customKey, { keep: true });
    assert.deepEqual(raw.openai, { type: "api_key" });
    assert.equal(raw["openai-codex"]?.access, "c1");
    assert.equal(raw["openai-codex"]?.refresh, "cr1");
    assert.equal(raw["openai-codex"]?.type, "oauth");
    assert.equal(raw.anthropic?.access, "a1");
    assert.ok(typeof raw.anthropic?.expires === "number");
  });
});
