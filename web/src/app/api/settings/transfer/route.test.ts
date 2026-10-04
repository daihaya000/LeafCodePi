import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetPiAgentDirCacheForTests, accountAuthPath, accountDir, createAccount, listAccounts } from "@/lib/accounts";
import { readPeerConfig, writePeerConfig } from "@backend-core/peer-auth-config.mjs";
import { accountAnthropicCookiePath, defaultTypesafeCookiePath, saveAccountAnthropicCookieFile, saveTypesafeCookieFile } from "@/lib/codexbar/browser-cookies";
import { accountOllamaCookiePath, saveOllamaCookieFile } from "@/lib/codexbar/providers/ollama-cloud";
import { readOpenRouterManagementKey, writeOpenRouterAccountConfig } from "@/lib/codexbar/providers/openrouter";
import { writeAccountOpenCodeGoWorkspace } from "@/lib/codexbar/providers/opencode-go";
import { getSetting, setSetting } from "@/lib/pi/web-settings";
import { exportSettingsBackup, importSettingsBackup } from "@/lib/pi/settings-transfer";
import { TransferRecoveryError, withTransferRecovery } from "@/lib/pi/transfer-recovery";
import { DELETE, GET, POST } from "./route";

const saved = {
  data: process.env.LEAFCODE_PI_DATA_DIR,
  agent: process.env.PI_CODING_AGENT_DIR,
  appdata: process.env.APPDATA,
  auth: process.env.LEAFCODE_PI_WEBUI_AUTH,
  token: process.env.LEAFCODE_PI_WEBUI_TOKEN,
  bind: process.env.LEAFCODE_PI_BIND_HOST,
};
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "leafcode-transfer-"));
  roots.push(root);
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.APPDATA = join(root, "appdata");
  __resetPiAgentDirCacheForTests();
  return root;
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/settings/transfer", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function getRequest(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/settings/transfer", { headers });
}
function deleteRequest(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/settings/transfer", { method: "DELETE", headers });
}
function restore(key: keyof typeof saved, env: string) {
  if (saved[key] === undefined) delete process.env[env];
  else process.env[env] = saved[key];
}

beforeEach(() => {
  process.env.LEAFCODE_PI_WEBUI_AUTH = "required";
  process.env.LEAFCODE_PI_WEBUI_TOKEN = "test-token";
  process.env.LEAFCODE_PI_BIND_HOST = "100.127.32.3";
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  restore("data", "LEAFCODE_PI_DATA_DIR");
  restore("agent", "PI_CODING_AGENT_DIR");
  restore("appdata", "APPDATA");
  restore("auth", "LEAFCODE_PI_WEBUI_AUTH");
  restore("token", "LEAFCODE_PI_WEBUI_TOKEN");
  restore("bind", "LEAFCODE_PI_BIND_HOST");
  __resetPiAgentDirCacheForTests();
});

describe("/api/settings/transfer", () => {
  it("exports settings without secrets, and imports only named settings", async () => {
    setup();
    process.env.LEAFCODE_PI_BIND_HOST = "127.0.0.1";
    setSetting("auto-optimize", "balanced");
    const account = createAccount({ label: "personal", providers: ["openrouter"] });
    const path = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ openrouter: { type: "api_key", key: "SECRET" } }));

    const exported = await POST(request({ action: "export", scope: "settings" }));
    expect(exported.status).toBe(200);
    const { backup } = await exported.json();
    expect(backup.settings["auto-optimize"]).toBe("balanced");
    expect(backup.credentials).toBeUndefined();
    expect(JSON.stringify(backup)).not.toContain("SECRET");

    setSetting("auto-optimize", "cost");
    setSetting("auto-agent-prompt", "keep me");
    const imported = await POST(request({ action: "import", backup }));
    expect(imported.status).toBe(200);
    expect(getSetting("auto-optimize")).toBe("balanced");
    expect(getSetting("auto-agent-prompt")).toBe("keep me");
  });

  it("round-trips provider auth, account IDs, cookie and management key without deleting other credentials", async () => {
    setup();
    const account = createAccount({ label: "personal", providers: ["openrouter", "ollama-cloud"] });
    const path = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ openrouter: { type: "api_key", key: "SECRET" } }));
    saveOllamaCookieFile(account.id, "# Netscape HTTP Cookie File\n.ollama.com\tTRUE\t/\tTRUE\t0\tsession\tcookie-secret\n");
    writeOpenRouterAccountConfig(path, { managementKey: "management-secret" });

    const response = await POST(request({ action: "export", scope: "credentials" }, { cookie: "leafcode-pi-token=test-token" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const { backup } = await response.json();
    expect(backup.credentials.accounts[0].record.id).toBe(account.id);
    expect(backup.credentials.accounts[0].auth.openrouter.key).toBe("SECRET");
    expect(backup.credentials.accounts[0].openrouterManagementKey).toBe("management-secret");
    expect(backup.settings).toBeUndefined();

    // 別環境で元のアカウント ID を維持し、既存の別プロバイダー認証を残す。
    setup();
    const targetPath = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify({ cursor: { type: "api_key", key: "existing" } }));
    const imported = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(imported.status).toBe(200);
    expect(listAccounts()[0].id).toBe(account.id);
    const restoredAuth = JSON.parse(readFileSync(targetPath, "utf8"));
    expect(restoredAuth.openrouter.key).toBe("SECRET");
    expect(restoredAuth.cursor.key).toBe("existing");
    expect(readFileSync(accountOllamaCookiePath(account.id)!, "utf8")).toContain("cookie-secret");
    expect(readOpenRouterManagementKey(accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!))).toBe("management-secret");
  });

  it("round-trips peer connection credentials through credential export/import", async () => {
    setup();
    const account = createAccount({ label: "peer", providers: ["anthropic"] });
    const peer = writePeerConfig(accountDir(account.id, process.env.PI_CODING_AGENT_DIR!), {
      peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic"], token: "k".repeat(43), createdAt: "2026-01-01T00:00:00.000Z",
    });
    const exported = await POST(request({ action: "export", scope: "credentials" }, { cookie: "leafcode-pi-token=test-token" }));
    expect(exported.status).toBe(200);
    const { backup } = await exported.json();
    expect(backup.credentials.accounts[0].peer).toEqual(peer);
    expect(backup.settings).toBeUndefined();

    setup();
    const imported = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(imported.status).toBe(200);
    expect(readPeerConfig(accountDir(account.id, process.env.PI_CODING_AGENT_DIR!))).toEqual(peer);
  });

  it("preserves SDK keyless API placeholders and legacy access-only OAuth entries", async () => {
    setup();
    const account = createAccount({ label: "Go", providers: ["opencode-go", "anthropic"] });
    const path = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      "opencode-go": { type: "api_key" },
      anthropic: { type: "oauth", access: "legacy-access" },
    }));
    const exported = await POST(request({ action: "export", scope: "credentials" }, { cookie: "leafcode-pi-token=test-token" }));
    expect(exported.status).toBe(200);
    const { backup } = await exported.json();
    setup();
    const imported = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(imported.status).toBe(200);
    const auth = JSON.parse(readFileSync(accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!), "utf8"));
    expect(auth["opencode-go"]).toEqual({ type: "api_key" });
    expect(auth.anthropic).toEqual({ type: "oauth", access: "legacy-access" });
  });

  it("round-trips default OAuth, Anthropic account cookie and shared TypeSafe cookie", async () => {
    setup();
    const account = createAccount({ label: "Claude", providers: ["anthropic"] });
    const authPath = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ typesafe: { type: "api_key", key: "default-key" } }));
    const anthCookie = "# Netscape HTTP Cookie File\n.claude.com\tTRUE\t/\tTRUE\t4102444800\tsessionKey\tant-session\n";
    const typeCookie = "# Netscape HTTP Cookie File\nconsole.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\tsession_id\tkey\nconsole.typesafe.ai\tFALSE\t/\tTRUE\t4102444800\torganization_id\torg\n";
    saveAccountAnthropicCookieFile(authPath, anthCookie);
    saveTypesafeCookieFile(typeCookie);
    const exported = await POST(request({ action: "export", scope: "credentials" }, { cookie: "leafcode-pi-token=test-token" }));
    expect(exported.status).toBe(200);
    const { backup } = await exported.json();
    setup();
    const imported = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(imported.status).toBe(200);
    expect(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8")).typesafe.key).toBe("default-key");
    expect(readFileSync(accountAnthropicCookiePath(accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!)), "utf8")).toContain("ant-session");
    expect(readFileSync(defaultTypesafeCookiePath(), "utf8")).toContain("organization_id");
  });

  it("resets stored provider credentials to a backup without touching settings or account records", async () => {
    setup();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const account = createAccount({ label: "personal", providers: ["openrouter", "anthropic"] });
    const authPath = accountAuthPath(account.id, agentDir);
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ openrouter: { type: "api_key", key: "ACCOUNT-SECRET" } }));
    const defaultAuth = join(agentDir, "auth.json");
    writeFileSync(defaultAuth, JSON.stringify({ typesafe: { type: "api_key", key: "DEFAULT-SECRET" } }));
    const peer = writePeerConfig(accountDir(account.id, agentDir), {
      peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic"], token: "p".repeat(43), createdAt: "2026-01-01T00:00:00.000Z",
    });
    const anthCookie = "# Netscape HTTP Cookie File\n.claude.com\tTRUE\t/\tTRUE\t0\tsessionKey\tant-session\n";
    saveAccountAnthropicCookieFile(authPath, anthCookie);
    saveTypesafeCookieFile("# Netscape HTTP Cookie File\nconsole.typesafe.ai\tFALSE\t/\tTRUE\t0\tsession_id\tkey\nconsole.typesafe.ai\tFALSE\t/\tTRUE\t0\torganization_id\torg\n");
    writeOpenRouterAccountConfig(authPath, { managementKey: "management-secret" });
    setSetting("auto-optimize", "balanced");

    const response = await DELETE(deleteRequest({ cookie: "leafcode-pi-token=test-token" }));
    expect(response.status).toBe(200);
    const result = await response.json() as { backupPath: string; accountCount: number };
    expect(result.accountCount).toBe(1);
    expect(existsSync(defaultAuth)).toBe(false);
    expect(existsSync(authPath)).toBe(false);
    expect(existsSync(join(accountDir(account.id, agentDir), "peer.json"))).toBe(false);
    expect(existsSync(accountAnthropicCookiePath(authPath))).toBe(false);
    expect(existsSync(defaultTypesafeCookiePath())).toBe(false);
    expect(existsSync(join(dirname(authPath), "openrouter.json"))).toBe(false);
    // アカウント一覧と設定は残り、旧認証は再インポート可能なバックアップへ退避される。
    expect(listAccounts()).toHaveLength(1);
    expect(getSetting("auto-optimize")).toBe("balanced");
    expect(existsSync(result.backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(result.backupPath, "utf8"));
    expect(backup.scope).toBe("credentials");
    expect(backup.credentials.defaultAuth.typesafe.key).toBe("DEFAULT-SECRET");
    expect(backup.credentials.accounts[0].auth.openrouter.key).toBe("ACCOUNT-SECRET");
    expect(backup.credentials.accounts[0].peer).toEqual(peer);
    expect(backup.credentials.accounts[0].openrouterManagementKey).toBe("management-secret");
    const recoveryDir = join(process.env.LEAFCODE_PI_DATA_DIR!, "settings-transfer-recovery");
    expect(existsSync(recoveryDir) ? readdirSync(recoveryDir) : []).toEqual([]);
  });

  it("denies credential reset without access-token protection", async () => {
    setup();
    expect((await DELETE(deleteRequest())).status).toBe(403);
    process.env.LEAFCODE_PI_BIND_HOST = "127.0.0.1";
    expect((await DELETE(deleteRequest())).status).toBe(200);
  });

  it("imports legacy combined settings and new account references without changing unrelated values", async () => {
    setup();
    const account = createAccount({ label: "model account", providers: ["openrouter"] });
    setSetting("generation-model", `${account.id}::openrouter::example-model`);
    setSetting("auto-optimize", "balanced");
    const backup = await exportSettingsBackup("all");
    setup();
    setSetting("auto-agent-prompt", "unrelated");
    const imported = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(imported.status).toBe(200);
    expect(listAccounts()[0].id).toBe(account.id);
    expect(getSetting("generation-model")).toBe(`${account.id}::openrouter::example-model`);
    expect(getSetting("auto-agent-prompt")).toBe("unrelated");
  });

  it("rejects combined settings-and-credential exports while keeping import compatibility", async () => {
    setup();
    const response = await POST(request({ action: "export", scope: "all" }, { cookie: "leafcode-pi-token=test-token" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "設定と認証は個別にエクスポートしてください" });
  });

  it("blocks credentials without access-token protection and rejects malformed archives before writing", async () => {
    setup();
    const denied = await POST(request({ action: "export", scope: "credentials" }));
    expect(denied.status).toBe(403);
    const settingsDenied = await POST(request({ action: "export", scope: "settings" }));
    expect(settingsDenied.status).toBe(403);
    const recoveryDenied = await POST(request({ action: "recover", recoveryId: "12345678-1234-1234-1234-123456789abc" }));
    expect(recoveryDenied.status).toBe(403);
    expect((await GET(getRequest())).status).toBe(403);
    const crossOrigin = await POST(request({ action: "export", scope: "credentials" }, { origin: "https://untrusted.example", cookie: "leafcode-pi-token=test-token" }));
    expect(crossOrigin.status).toBe(403);
    process.env.LEAFCODE_PI_WEBUI_AUTH = "";
    const alsoDenied = await POST(request({ action: "export", scope: "credentials" }, { cookie: "leafcode-pi-token=test-token" }));
    expect(alsoDenied.status).toBe(403);
    process.env.LEAFCODE_PI_BIND_HOST = "127.0.0.1";
    const localAllowed = await POST(request({ action: "export", scope: "credentials" }));
    expect(localAllowed.status).toBe(200);
    const rebinding = await POST(new NextRequest("http://rebinding.example/api/settings/transfer", {
      method: "POST",
      headers: { origin: "http://rebinding.example", "content-type": "application/json" },
      body: JSON.stringify({ action: "export", scope: "credentials" }),
    }));
    expect(rebinding.status).toBe(403);
    const spoofedHeader = await POST(request({ action: "export", scope: "settings" }, { host: "rebinding.example" }));
    expect(spoofedHeader.status).toBe(403);
    process.env.LEAFCODE_PI_BIND_HOST = "100.127.32.3";
    process.env.LEAFCODE_PI_WEBUI_AUTH = "required";

    const backup = { format: "leafcode-pi-settings", version: 1, scope: "credentials", credentials: {
      defaultAuth: {}, accounts: [{ record: { id: "../escape", label: "bad", enabled: true, providers: ["openrouter"] }, auth: {}, cookies: {} }], sharedCookies: {},
    } };
    const invalid = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(invalid.status).toBe(400);
    expect(existsSync(join(process.env.LEAFCODE_PI_DATA_DIR!, "accounts.json"))).toBe(false);

    backup.credentials.accounts[0].record.id = "safe-id";
    backup.credentials.accounts[0].cookies = { ollama: "not a cookie" };
    const invalidCookie = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(invalidCookie.status).toBe(400);
    expect(existsSync(join(process.env.LEAFCODE_PI_DATA_DIR!, "accounts.json"))).toBe(false);
  });

  it("restores account metadata, auth, cookie and settings after a late write failure", async () => {
    setup();
    const account = createAccount({ label: "Providers", providers: ["ollama-cloud", "openrouter", "opencode-go"] });
    const sourceAccountAuth = accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!);
    writeOpenRouterAccountConfig(sourceAccountAuth, { managementKey: "imported-management" });
    writeAccountOpenCodeGoWorkspace(sourceAccountAuth, "imported-workspace");
    saveTypesafeCookieFile("# Netscape HTTP Cookie File\n.console.typesafe.ai\tTRUE\t/\tTRUE\t0\tsession_id\timported-cookie\n.console.typesafe.ai\tTRUE\t/\tTRUE\t0\torganization_id\torg-source\n");
    const sourceDefaultAuth = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
    mkdirSync(dirname(sourceDefaultAuth), { recursive: true });
    writeFileSync(sourceDefaultAuth, JSON.stringify({ typesafe: { type: "api_key", key: "imported" } }));
    saveOllamaCookieFile(account.id, "# Netscape HTTP Cookie File\n.ollama.com\tTRUE\t/\tTRUE\t0\tsession\timported-cookie\n");
    setSetting("auto-optimize", "balanced");
    const backup = await exportSettingsBackup("all");

    setup();
    const targetDefaultAuth = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
    mkdirSync(dirname(targetDefaultAuth), { recursive: true });
    writeFileSync(targetDefaultAuth, JSON.stringify({ typesafe: { type: "api_key", key: "original" } }));
    setSetting("auto-optimize", "cost");
    saveTypesafeCookieFile("# Netscape HTTP Cookie File\n.console.typesafe.ai\tTRUE\t/\tTRUE\t0\tsession_id\toriginal-cookie\n.console.typesafe.ai\tTRUE\t/\tTRUE\t0\torganization_id\torg-target\n");
    await expect(importSettingsBackup(backup, { afterApply: () => { throw new Error("simulated disk failure"); } }))
      .rejects.toThrow("simulated disk failure");

    expect(listAccounts()).toHaveLength(0);
    expect(JSON.parse(readFileSync(targetDefaultAuth, "utf8")).typesafe.key).toBe("original");
    expect(getSetting("auto-optimize")).toBe("cost");
    expect(existsSync(accountOllamaCookiePath(account.id)!)).toBe(false);
    expect(existsSync(join(dirname(accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!)), "openrouter.json"))).toBe(false);
    expect(existsSync(join(dirname(accountAuthPath(account.id, process.env.PI_CODING_AGENT_DIR!)), "opencode-go.json"))).toBe(false);
    expect(readFileSync(defaultTypesafeCookiePath(), "utf8")).toContain("original-cookie");
    const recoveryDir = join(process.env.LEAFCODE_PI_DATA_DIR!, "settings-transfer-recovery");
    expect(readdirSync(recoveryDir)).toEqual([]);
  });

  it("lists and discards only preserved journals on an authorized connection", async () => {
    const root = setup();
    const blocked = join(root, "blocked");
    let recoveryPath = "";
    try {
      await withTransferRecovery([blocked], async () => { mkdirSync(blocked); throw new Error("disk error"); });
    } catch (error) { recoveryPath = (error as TransferRecoveryError).recoveryPath; }
    const id = basename(recoveryPath, ".json");
    const listing = await GET(getRequest({ cookie: "leafcode-pi-token=test-token" }));
    expect((await listing.json()).recoveries).toContain(id);
    const discarded = await POST(request({ action: "discard-recovery", recoveryId: id }, { cookie: "leafcode-pi-token=test-token" }));
    expect(discarded.status).toBe(200);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("restores a preserved snapshot after the filesystem issue is resolved", async () => {
    const root = setup();
    const blocked = join(root, "blocked");
    let recoveryPath = "";
    try {
      await withTransferRecovery([blocked], async () => {
        mkdirSync(blocked);
        throw new Error("disk error");
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TransferRecoveryError);
      recoveryPath = (error as TransferRecoveryError).recoveryPath;
    }
    expect(existsSync(recoveryPath)).toBe(true);
    rmSync(blocked, { recursive: true });
    const response = await POST(request({ action: "recover", recoveryId: basename(recoveryPath, ".json") }, { cookie: "leafcode-pi-token=test-token" }));
    expect(response.status).toBe(200);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  it("does not import settings or accounts when a combined archive contains an invalid value", async () => {
    setup();
    const backup = { format: "leafcode-pi-settings", version: 1, scope: "all", settings: { "auto-optimize": "invalid" }, credentials: {
      defaultAuth: {}, accounts: [{ record: { id: "safe-id", label: "valid", enabled: true, providers: ["openrouter"] }, auth: {}, cookies: {} }], sharedCookies: {},
    } };
    const response = await POST(request({ action: "import", backup }, { cookie: "leafcode-pi-token=test-token" }));
    expect(response.status).toBe(400);
    expect(existsSync(join(process.env.LEAFCODE_PI_DATA_DIR!, "accounts.json"))).toBe(false);
    expect(getSetting("auto-optimize")).toBeNull();
  });
});
