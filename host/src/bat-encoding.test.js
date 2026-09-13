import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SKIP_DIR_NAMES = new Set([".git", ".next", "node_modules", "coverage"]);

function listOnDiskBatchFiles(dir = repoRoot, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listOnDiskBatchFiles(full, out);
      continue;
    }
    if (/\.(bat|cmd)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function listTrackedBatchFiles() {
  try {
    const output = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
    return output
      .split(/\r?\n/)
      .filter((line) => /\.(bat|cmd)$/i.test(line))
      .map((line) => join(repoRoot, line))
      .filter((filePath) => existsSync(filePath));
  } catch {
    return [];
  }
}

function findLineNumber(bytes, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (bytes[i] === 0x0a) line += 1;
  }
  return line;
}

function relName(filePath) {
  return relative(repoRoot, filePath).split(sep).join("/");
}

function assertNoBom(bytes, filePath) {
  const name = relName(filePath);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    assert.fail(`${name} has a UTF-8 BOM`);
  }
}

function assertBufferIsAsciiOnly(bytes, filePath) {
  const name = relName(filePath);
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 0x7f) {
      assert.fail(
        `${name} contains a non-ASCII byte at offset ${i} (line ${findLineNumber(bytes, i)})`,
      );
    }
  }
}

function assertArtifactLineEndings(bytes, filePath) {
  const name = relName(filePath);
  if (process.platform !== "win32") {
    // Git checkouts on POSIX commonly normalize text files to LF. Reject only
    // malformed bare CR bytes there; Windows release checkouts stay strict CRLF.
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) {
        assert.fail(`${name} has a bare CR at offset ${i} (line ${findLineNumber(bytes, i)})`);
      }
    }
    return;
  }
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) {
      assert.fail(`${name} has a lone LF at offset ${i} (line ${findLineNumber(bytes, i)})`);
    }
  }
  if (bytes.length < 2 || bytes[bytes.length - 2] !== 0x0d || bytes[bytes.length - 1] !== 0x0a) {
    assert.fail(`${name} does not end with CRLF`);
  }
}

function assertSafeBatchBytes(filePath) {
  const bytes = readFileSync(filePath);
  assertNoBom(bytes, filePath);
  assertBufferIsAsciiOnly(bytes, filePath);
  assertArtifactLineEndings(bytes, filePath);
}

test("every on-disk batch file uses platform-safe line endings", () => {
  const files = listOnDiskBatchFiles();
  assert.ok(files.length > 0, "expected at least one on-disk .bat/.cmd file");
  for (const filePath of files) assertSafeBatchBytes(filePath);
});

test("tracked batch files use platform-safe line endings when git is available", () => {
  const files = listTrackedBatchFiles();
  for (const filePath of files) assertSafeBatchBytes(filePath);
});

const messageDir = join(repoRoot, "scripts", "setup-messages");

test("Windows launcher quotes mmproj paths and avoids arbitrary listener kills", () => {
  const launcher = readFileSync(join(repoRoot, "scripts", "llama-server-load.bat"), "ascii");
  assert.match(launcher, /set "MMPROJ_PATH=%MODEL_DIR%\\%MMPROJ_FILE%"/);
  assert.equal((launcher.match(/--mmproj "%MMPROJ_PATH%"/g) ?? []).length, 3);
  assert.doesNotMatch(launcher, /MMPROJ_ARGS/);
  assert.match(launcher, /refusing to kill an unrelated listener/);
  assert.doesNotMatch(launcher, /taskkill/);
});

test("setup message files are UTF-8 without BOM and platform-safe line endings", () => {
  const names = readdirSync(messageDir).filter((name) => name.endsWith(".txt"));
  assert.ok(names.length >= 3, `expected setup messages, got ${names.length}`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const name of names) {
    const filePath = join(messageDir, name);
    const bytes = readFileSync(filePath);
    assertNoBom(bytes, filePath);
    const text = decoder.decode(bytes);
    assert.ok(bytes.some((byte) => byte > 0x7f), `${name} contains only ASCII`);
    assertArtifactLineEndings(bytes, filePath);
    assert.ok(text.includes("[LeafCodePi]"), `${name} must mention LeafCodePi`);
  }
});
