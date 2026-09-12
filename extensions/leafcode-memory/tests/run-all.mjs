#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = join(root, "tests");
const rawTimeout = process.env.TEST_TIMEOUT ?? "120";

if (!/^\d+(?:\.\d+)?$/.test(rawTimeout) || !Number.isFinite(Number(rawTimeout))) {
  console.error(
    `Invalid TEST_TIMEOUT: ${rawTimeout} (expected a non-negative number of seconds)`,
  );
  process.exit(2);
}

const timeoutSeconds = Number(rawTimeout);
const windowsCommand = process.env.ComSpec ?? "cmd.exe";

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(file)));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(file);
    }
  }
  return files;
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function runTestFile(file) {
  const displayFile = relative(root, file).split(sep).join("/");
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? windowsCommand : "npx";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "npx.cmd", "tsx", "--test", displayFile]
      : ["tsx", "--test", displayFile];
    const child = spawn(command, args, {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: "inherit",
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let timeout;
    let killTimer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, displayFile, timedOut });
    };

    if (timeoutSeconds > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stopProcess(child);
        killTimer = setTimeout(() => child.kill(), 5_000);
      }, timeoutSeconds * 1_000);
    }
    child.once("error", (error) => {
      console.error(error);
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));
  });
}

const files = (await collectTestFiles(testsRoot)).sort();
let passed = 0;
for (const file of files) {
  const displayFile = relative(root, file).split(sep).join("/");
  console.log(`--- ${displayFile} ---`);
  const result = await runTestFile(file);
  if (result.code === 0) {
    passed += 1;
    continue;
  }
  if (result.timedOut) {
    console.log(`TIMEOUT (>${timeoutSeconds}s): ${result.displayFile}`);
  } else {
    console.log(`FAILED (exit ${result.code}): ${result.displayFile}`);
  }
  process.exit(1);
}

console.log(`All ${passed} test files passed`);
