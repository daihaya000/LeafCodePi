import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount, getAccount, importAccountRecords, patchAccount } from "./accounts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "account-auto-reset-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("account automatic reset persistence", () => {
  it("preserves OFF through unrelated patches and importing a backup into a new account", () => {
    const a = createAccount({ label: "A", providers: ["openai-codex"], note: "keep" });
    patchAccount(a.id, { codexResetAutoConsume: false });
    patchAccount(a.id, { label: "renamed" });
    const saved = getAccount(a.id)!;
    expect(saved).toMatchObject({ codexResetAutoConsume: false, enabled: true, note: "keep" });
    importAccountRecords([{ ...saved, id: "restored" }]);
    expect(getAccount("restored")?.codexResetAutoConsume).toBe(false);
  });

  it("does not overwrite an existing local preference when importing the same account", () => {
    const a = createAccount({ label: "A", providers: ["openai-codex"] });
    patchAccount(a.id, { codexResetAutoConsume: false });
    importAccountRecords([{ ...a, codexResetAutoConsume: true }]);
    expect(getAccount(a.id)?.codexResetAutoConsume).toBe(false);
  });
});
