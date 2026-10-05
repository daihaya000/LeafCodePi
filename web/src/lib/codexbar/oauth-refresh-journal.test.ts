import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  clearOAuthRefreshJournal,
  hasOAuthRefreshJournal,
  oauthRefreshJournalPath,
  recoverOAuthRefreshJournal,
  writeOAuthRefreshJournal,
} from "./oauth-refresh-journal";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oauth-refresh-journal-"));
  dirs.push(dir);
  return { dir, authPath: join(dir, "auth.json") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OAuth refresh journal", () => {
  it("recovers rotated credentials after module/process state is gone", async () => {
    const { authPath } = fixture();
    const previous = { accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture" };
    const refreshed = { accessToken: "new-access-fixture", refreshToken: "new-refresh-fixture" };
    writeFileSync(authPath, JSON.stringify(previous), "utf8");
    writeOAuthRefreshJournal(authPath, "test-provider", previous, refreshed);
    if (process.platform !== "win32") {
      assert.equal(statSync(oauthRefreshJournalPath(authPath, "test-provider")).mode & 0o777, 0o600);
    }

    const recovered = await recoverOAuthRefreshJournal({
      authPath,
      provider: "test-provider",
      readCurrent: () => JSON.parse(readFileSync(authPath, "utf8")),
      same: (left, right) => left.accessToken === right.accessToken && left.refreshToken === right.refreshToken,
      persist: (tokens) => writeFileSync(authPath, JSON.stringify(tokens), "utf8"),
    });

    assert.deepEqual(recovered, refreshed);
    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), refreshed);
    assert.equal(hasOAuthRefreshJournal(authPath, "test-provider"), false);
  });

  it("keeps the journal and returns rotated credentials when persistence still fails", async () => {
    const { authPath } = fixture();
    const previous = { accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture" };
    const refreshed = { accessToken: "new-access-fixture", refreshToken: "new-refresh-fixture" };
    writeFileSync(authPath, JSON.stringify(previous), "utf8");
    writeOAuthRefreshJournal(authPath, "test-provider", previous, refreshed);

    const recovered = await recoverOAuthRefreshJournal({
      authPath,
      provider: "test-provider",
      readCurrent: () => JSON.parse(readFileSync(authPath, "utf8")),
      same: (left, right) => left.accessToken === right.accessToken && left.refreshToken === right.refreshToken,
      persist: () => { throw new Error("simulated disk failure"); },
    });

    assert.deepEqual(recovered, refreshed);
    assert.equal(hasOAuthRefreshJournal(authPath, "test-provider"), true);
  });

  it("does not overwrite external credentials or resurrect a deleted auth file", async () => {
    const { authPath } = fixture();
    const previous = { accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture" };
    const refreshed = { accessToken: "new-access-fixture", refreshToken: "new-refresh-fixture" };
    writeOAuthRefreshJournal(authPath, "test-provider", previous, refreshed);
    writeFileSync(authPath, JSON.stringify({ accessToken: "external-access-fixture", refreshToken: "external-refresh-fixture" }), "utf8");

    const external = await recoverOAuthRefreshJournal({
      authPath,
      provider: "test-provider",
      readCurrent: () => JSON.parse(readFileSync(authPath, "utf8")),
      same: (left, right) => left.accessToken === right.accessToken && left.refreshToken === right.refreshToken,
      persist: () => { throw new Error("must not persist over an external login"); },
    });
    assert.equal(external?.accessToken, "external-access-fixture");
    assert.equal(hasOAuthRefreshJournal(authPath, "test-provider"), false);

    writeOAuthRefreshJournal(authPath, "test-provider", previous, refreshed);
    rmSync(authPath);
    const deleted = await recoverOAuthRefreshJournal({
      authPath,
      provider: "test-provider",
      readCurrent: () => null,
      same: () => false,
      persist: () => { throw new Error("must not recreate a logged-out auth file"); },
    });
    assert.equal(deleted, null);
    assert.equal(existsSync(authPath), false);
    assert.equal(hasOAuthRefreshJournal(authPath, "test-provider"), false);
  });

  it("does not restore over an existing logged-out auth file", async () => {
    const { authPath } = fixture();
    const previous = { accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture" };
    const refreshed = { accessToken: "new-access-fixture", refreshToken: "new-refresh-fixture" };
    writeFileSync(authPath, JSON.stringify({}), "utf8");
    writeOAuthRefreshJournal(authPath, "test-provider", previous, refreshed);
    let persistCalls = 0;

    const recovered = await recoverOAuthRefreshJournal({
      authPath,
      provider: "test-provider",
      readCurrent: () => {
        const current = JSON.parse(readFileSync(authPath, "utf8"));
        return current.accessToken ? current : null;
      },
      same: (left, right) => left.accessToken === right.accessToken && left.refreshToken === right.refreshToken,
      persist: () => { persistCalls += 1; },
    });

    assert.equal(recovered, null);
    assert.equal(persistCalls, 0);
    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
    assert.equal(hasOAuthRefreshJournal(authPath, "test-provider"), false);
  });

  it("keeps the journal when auth cannot be read safely", async () => {
    const { authPath } = fixture();
    const previous = { accessToken: "old-access-fixture", refreshToken: "old-refresh-fixture" };
    const refreshed = { accessToken: "new-access-fixture", refreshToken: "new-refresh-fixture" };
    writeFileSync(authPath, JSON.stringify(previous), "utf8");
    writeOAuthRefreshJournal(authPath, "test-provider", previous, refreshed);

    const recovered = await recoverOAuthRefreshJournal<{ accessToken: string; refreshToken: string }>({
      authPath,
      provider: "test-provider",
      readCurrent: () => undefined,
      same: (left, right) => left.accessToken === right.accessToken && left.refreshToken === right.refreshToken,
      persist: () => { throw new Error("must not persist while auth is unreadable"); },
    });

    assert.equal(recovered, null);
    assert.equal(hasOAuthRefreshJournal(authPath, "test-provider"), true);
  });

  it("clears only the selected provider journal", () => {
    const { authPath } = fixture();
    writeOAuthRefreshJournal(authPath, "anthropic", { accessToken: "a1" }, { accessToken: "a2" });
    writeOAuthRefreshJournal(authPath, "openai-codex", { accessToken: "c1" }, { accessToken: "c2" });

    clearOAuthRefreshJournal(authPath, "anthropic");

    assert.equal(existsSync(oauthRefreshJournalPath(authPath, "anthropic")), false);
    assert.equal(hasOAuthRefreshJournal(authPath, "openai-codex"), true);
  });
});
