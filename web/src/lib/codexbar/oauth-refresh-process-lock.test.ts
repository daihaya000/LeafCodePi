import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";

const dirs: string[] = [];
const utilityUrl = pathToFileURL(fileURLToPath(new URL("../../../../backend/runtime-src/lib/codexbar/utils.ts", import.meta.url))).href;
const workerSource = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { withRefreshFileLock } from ${JSON.stringify(utilityUrl)};
const [lockPath, statePath, role, markerPath, releasePath] = process.argv.slice(1);
writeFileSync(markerPath + ".attempting", "1");
await withRefreshFileLock(lockPath, async () => {
  writeFileSync(markerPath + ".entered", "1");
  if (role === "first") {
    while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const auth = JSON.parse(readFileSync(lockPath, "utf8"));
  const refreshTokenUsed = auth.refreshToken;
  if (auth.refreshToken === "old-refresh-fixture") {
    auth.refreshToken = "rotated-refresh-fixture";
    auth.refreshCount += 1;
    writeFileSync(lockPath, JSON.stringify(auth));
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.order.push(role);
  state.refreshTokensUsed.push(refreshTokenUsed);
  state.count += 1;
  writeFileSync(statePath, JSON.stringify(state));
});
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filePath) && Date.now() < deadline) await delay(10);
  assert.equal(existsSync(filePath), true, `Timed out waiting for ${filePath}`);
}

function runWorker(args: string[]): { child: ReturnType<typeof spawn>; exit: Promise<{ code: number | null; stderr: string }> } {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", workerSource, ...args],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  return { child, exit };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cross-process OAuth refresh lock", () => {
  it("serializes two real Node processes sharing a rotating-token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oauth-refresh-process-lock-"));
    dirs.push(dir);
    const authPath = join(dir, "auth.json");
    const statePath = join(dir, "state.json");
    const markerPath = join(dir, "worker");
    const releasePath = join(dir, "release");
    writeFileSync(authPath, JSON.stringify({ refreshToken: "old-refresh-fixture", refreshCount: 0 }), "utf8");
    writeFileSync(statePath, JSON.stringify({ count: 0, order: [], refreshTokensUsed: [] }), "utf8");

    const first = runWorker([authPath, statePath, "first", `${markerPath}.first`, releasePath]);
    let second: ReturnType<typeof runWorker> | undefined;
    try {
      await waitForFile(`${markerPath}.first.entered`);
      second = runWorker([authPath, statePath, "second", `${markerPath}.second`, releasePath]);
      await waitForFile(`${markerPath}.second.attempting`);
      await delay(100);
      assert.equal(existsSync(`${markerPath}.second.entered`), false, "second process must wait while first owns the lock");

      writeFileSync(releasePath, "1", "utf8");
      const [firstResult, secondResult] = await Promise.all([first.exit, second.exit]);
      assert.equal(firstResult.code, 0, firstResult.stderr);
      assert.equal(secondResult.code, 0, secondResult.stderr);
      assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), {
        count: 2,
        order: ["first", "second"],
        refreshTokensUsed: ["old-refresh-fixture", "rotated-refresh-fixture"],
      });
      assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {
        refreshToken: "rotated-refresh-fixture",
        refreshCount: 1,
      });
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, "1", "utf8");
      await Promise.all([
        first.exit.catch(() => undefined),
        second?.exit.catch(() => undefined),
      ]);
    }
  }, 30_000);
});
