import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resetIcaclsCache, restrictToCurrentUser } from "./secure-file.js";

test("icacls runs once per file identity and again for a recreated file", () => {
  const dir = mkdtempSync(join(tmpdir(), "secure-file-"));
  const previous = process.env.USERNAME;
  process.env.USERNAME = process.env.USERNAME || "tester";
  resetIcaclsCache();
  try {
    const file = join(dir, "secret.json");
    writeFileSync(file, "{}");
    let calls = 0;
    const deps = { platform: "win32", execFile: () => { calls += 1; } };
    assert.equal(restrictToCurrentUser(file, deps), true);
    writeFileSync(file, "{ }");
    assert.equal(restrictToCurrentUser(file, deps), true);
    assert.equal(calls, 1, "a rewrite of the same file keeps its ACL");
    unlinkSync(file);
    writeFileSync(file, "{}");
    assert.equal(restrictToCurrentUser(file, deps), true);
    assert.equal(calls, 2, "a recreated file is locked down again");
  } finally {
    if (previous === undefined) delete process.env.USERNAME; else process.env.USERNAME = previous;
    resetIcaclsCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
