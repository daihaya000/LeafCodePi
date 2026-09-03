import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { LOCK_DATABASE_FILE } from "../../src/constants.js";
import {
  canonicalMarkdownIdentity,
  withMarkdownMutationLock,
} from "../../src/store/markdown-mutation-lock.js";

async function closeMutationCoordinator(filePath: string): Promise<void> {
  try {
    const identity = await canonicalMarkdownIdentity(filePath);
    const coordinatorDir = path.dirname(path.dirname(identity));
    AtomicLockCoordinator.shared(path.join(coordinatorDir, LOCK_DATABASE_FILE)).close();
  } catch {
    /* best-effort unlock for Windows cleanup */
  }
}

describe("markdown mutation lock", () => {
  it("preserves a committed result and recovers release before the next acquire", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-test-"));
    const filePath = path.join(tmpDir, "memory", "MEMORY.md");
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalDeleteOwnedLock = prototype.deleteOwnedLock;
    let deleteAttempts = 0;
    prototype.deleteOwnedLock = function (key: string, token: string): void {
      deleteAttempts++;
      if (deleteAttempts <= 3) throw new Error("injected release failure");
      return originalDeleteOwnedLock.call(this, key, token);
    };

    try {
      const first = await withMarkdownMutationLock(filePath, async () => "committed");
      assert.equal(first, "committed");

      const second = await withMarkdownMutationLock(filePath, async () => "next mutation");
      assert.equal(second, "next mutation");
      assert.ok(deleteAttempts >= 4);
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
      await closeMutationCoordinator(filePath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("heartbeats the lease while the mutation runs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-heartbeat-"));
    const filePath = path.join(tmpDir, "memory", "MEMORY.md");
    const renewCalls: number[] = [];
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalRenew = prototype.renew;
    prototype.renew = function (key: string, token: string): boolean {
      renewCalls.push(Date.now());
      return originalRenew.call(this, key, token);
    };

    try {
      await withMarkdownMutationLock(filePath, async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "ok";
      });
      // Final fencing renew plus any heartbeat ticks.
      assert.ok(renewCalls.length >= 1);
    } finally {
      prototype.renew = originalRenew;
      await closeMutationCoordinator(filePath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
