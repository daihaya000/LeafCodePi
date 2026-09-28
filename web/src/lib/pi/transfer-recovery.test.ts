import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TransferRecoveryError, restoreTransferRecoveryFile, withTransferRecovery } from "./transfer-recovery";

const originalDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "leafcode-transfer-recovery-"));
  roots.push(root);
  process.env.LEAFCODE_PI_DATA_DIR = root;
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = originalDataDir;
});

describe("withTransferRecovery", () => {
  it("restores original bytes and removes newly created files after a failure", async () => {
    const root = setup();
    const existing = join(root, "original.json");
    const created = join(root, "new.json");
    const bytes = Buffer.from([0xEF, 0xBB, 0xBF, 0x41]);
    writeFileSync(existing, bytes, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(existing, 0o600);
    await expect(withTransferRecovery([existing, created], async () => {
      writeFileSync(existing, "changed");
      writeFileSync(created, "new secret");
      throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect(readFileSync(existing)).toEqual(bytes);
    expect(existsSync(created)).toBe(false);
    if (process.platform !== "win32") expect(statSync(existing).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "settings-transfer-recovery"))).toEqual([]);
  });

  it("does not start the import when an existing target cannot be snapshotted", async () => {
    const root = setup();
    const directory = join(root, "not-a-file");
    mkdirSync(directory);
    let applied = false;
    await expect(withTransferRecovery([directory], async () => { applied = true; }))
      .rejects.toThrow("通常のファイルではない");
    expect(applied).toBe(false);
    expect(existsSync(join(root, "settings-transfer-recovery"))).toBe(false);
  });

  it("removes the sensitive journal after success", async () => {
    const root = setup();
    const file = join(root, "auth.json");
    expect(await withTransferRecovery([file], async () => { writeFileSync(file, "imported"); return "ok"; })).toBe("ok");
    expect(readFileSync(file, "utf8")).toBe("imported");
    expect(readdirSync(join(root, "settings-transfer-recovery"))).toEqual([]);
  });

  it("rejects overlapping imports in the same server process", async () => {
    const root = setup();
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = withTransferRecovery([join(root, "first")], async () => { await barrier; });
    await expect(withTransferRecovery([join(root, "second")], async () => undefined))
      .rejects.toMatchObject({ status: 409 });
    release();
    await first;
  });

  it("refuses a corrupted recovery journal before touching the target", async () => {
    const root = setup();
    const file = join(root, "blocked");
    let recoveryPath = "";
    try {
      await withTransferRecovery([file], async () => { mkdirSync(file); throw new Error("import failed"); });
    } catch (error) { recoveryPath = (error as TransferRecoveryError).recoveryPath; }
    const journal = JSON.parse(readFileSync(recoveryPath, "utf8"));
    journal.files[0].content = "Y29ycnVwdA==";
    writeFileSync(recoveryPath, JSON.stringify(journal));
    rmSync(file, { recursive: true });
    await expect(restoreTransferRecoveryFile(recoveryPath)).rejects.toThrow("保全ファイルの形式が不正です");
    expect(existsSync(recoveryPath)).toBe(true);
  });

  it("keeps a private recovery journal and reports its path when rollback is impossible", async () => {
    const root = setup();
    const file = join(root, "blocked");
    let failure: unknown;
    try {
      await withTransferRecovery([file], async () => {
        mkdirSync(file); // rollback of a previously absent file cannot remove a directory
        throw new Error("import failed");
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TransferRecoveryError);
    const recoveryPath = (failure as TransferRecoveryError).recoveryPath;
    expect(existsSync(recoveryPath)).toBe(true);
    if (process.platform !== "win32") expect(statSync(recoveryPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(recoveryPath, "utf8")).toContain("leafcode-pi-transfer-recovery");
    rmSync(file, { recursive: true }); // I/O 障害を解消してから手動復旧する。
    await restoreTransferRecoveryFile(recoveryPath);
    expect(existsSync(recoveryPath)).toBe(false);
  });
});
