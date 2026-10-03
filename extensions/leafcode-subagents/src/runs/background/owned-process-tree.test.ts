import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createOwnedProcessTreeController } from "./owned-process-tree.ts";

const isWindows = process.platform === "win32";

/** A long-lived child plus its exit promise, so the test reaps it instead of leaking a zombie. */
function spawnChild(): { pid: number; exited: Promise<void> } {
  const child: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  if (!child.pid) throw new Error("child pid missing");
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return { pid: child.pid, exited };
}

describe("owned process tree termination", () => {
  it("terminates the tree on this platform and reports an observed outcome", async () => {
    const { pid, exited } = spawnChild();
    const controller = createOwnedProcessTreeController(pid, { termGraceMs: 500, killVerifyMs: 5_000 });

    const terminal = await controller.terminate();
    await exited;

    expect(terminal.state).toBe("observed");
    if (isWindows) {
      expect(terminal.mechanism).toBe("windows-taskkill-tree");
      if (terminal.state === "observed") expect(terminal.processId).toBe(pid);
    } else {
      expect(terminal.mechanism).toBe("posix-process-group");
      if (terminal.state === "observed") expect(terminal.processGroupId).toBe(pid);
    }
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("runs the tree cleanup exactly once", async () => {
    const { pid, exited } = spawnChild();
    const controller = createOwnedProcessTreeController(pid, { termGraceMs: 500, killVerifyMs: 5_000 });

    const [first, second] = await Promise.all([controller.terminate(), controller.finishAfterWriterClose()]);
    await exited;

    expect(second).toBe(first);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("reports an already-gone process as observed without throwing", async () => {
    const { pid, exited } = spawnChild();
    if (isWindows) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    else process.kill(pid, "SIGKILL");
    await exited;

    const terminal = await createOwnedProcessTreeController(pid, { termGraceMs: 500, killVerifyMs: 2_000 }).terminate();

    expect(terminal.state).toBe("observed");
  }, 20_000);
});