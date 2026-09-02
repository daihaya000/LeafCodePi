import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogFileWriter } from "./log-file.js";

test("log writer creates a private POSIX log", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-log-"));
  try {
    const writer = createLogFileWriter(dir);
    writer.write({ source: "host", level: "log", text: "hello" });
    const file = join(dir, "host.log");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, "utf8"), /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log writer repairs an existing POSIX log", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-log-"));
  try {
    const file = join(dir, "host.log");
    writeFileSync(file, "old\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    createLogFileWriter(dir).write({ source: "host", level: "log", text: "new" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
