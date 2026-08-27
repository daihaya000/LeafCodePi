import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCookieHeader,
  cookieHeaderFromNetscapeText,
  filterCookiesForDomain,
  parseNetscapeCookieText,
} from "./netscape-cookies";
import {
  accountOllamaCookiePath,
  createOllamaCloudProvider,
  ollamaCookieFilePath,
  parseOllamaHtml,
} from "./providers/ollama-cloud";
import { parseOpenCodeGoHtml } from "./providers/opencode-go";
import {
  buildQwenCloudForm,
  consoleApiUrl,
  extractQwenCloudSecToken,
  isQwenCloudCookieHostAllowed,
  isQwenCloudLoginResponse,
  parseQwenConsoleUsage,
  parseQwenUsage,
} from "./providers/qwen-cloud";
import {
  accountOpenCodeCookiePath,
  createCookieHeaderForUrl,
  deleteAccountOpenCodeCookieFile,
  extractOpenCodeCookieHeader,
  parseQwenCloudNetscapeText,
  saveAccountOpenCodeCookieFile,
} from "./browser-cookies";
import {
  createOpenCodeGoProvider,
  readAccountOpenCodeGoWorkspace,
  writeAccountOpenCodeGoWorkspace,
} from "./providers/opencode-go";

describe("netscape cookies", () => {
  const fixture = `# Netscape HTTP Cookie File
.example.com	TRUE	/	FALSE	4102444800	skip	no
#HttpOnly_.ollama.com	TRUE	/	TRUE	4102444800	session	abc
.ollama.com	TRUE	/	FALSE	1	expired	gone
.ollama.com	TRUE	/	TRUE	4102444800	token	xyz
`;

  it("parses HttpOnly lines and builds domain-filtered header", () => {
    const cookies = parseNetscapeCookieText(fixture);
    expect(cookies).toHaveLength(4);
    const filtered = filterCookiesForDomain(
      cookies,
      "ollama.com",
      1_700_000_000,
    );
    expect(filtered.map((c) => c.name).sort()).toEqual(["session", "token"]);
    const header = buildCookieHeader(filtered);
    expect(header).toContain("session=abc");
    expect(header).toContain("token=xyz");
    expect(header).not.toContain("expired");
  });

  it("returns null when no matching cookies", () => {
    expect(cookieHeaderFromNetscapeText(fixture, "other.com")).toBeNull();
  });
});

describe("ollama cookie scope", () => {
  const previousAppData = process.env.APPDATA;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function isolateConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-ollama-cookie-"));
    tempDirs.push(dir);
    process.env.APPDATA = dir;
    return join(dir, "CodexBar");
  }

  it("rejects account ids that could escape the cookie directory", () => {
    isolateConfigDir();
    expect(accountOllamaCookiePath("../../evil")).toBeNull();
    expect(accountOllamaCookiePath("acc/1")).toBeNull();
    expect(accountOllamaCookiePath("")).toBeNull();
    expect(accountOllamaCookiePath("acc-1")).toContain(
      "ollama_cookies.acc-1.txt",
    );
  });

  it("keeps account cookies separate and never falls back to the shared file", () => {
    const configDir = isolateConfigDir();
    mkdirSync(configDir, { recursive: true });
    // 共有 cookie だけが存在する状態
    const shared = join(configDir, "ollama_cookies.txt");
    writeFileSync(shared, "# Netscape HTTP Cookie File\n", "utf8");
    expect(ollamaCookieFilePath()).toBe(shared);
    expect(ollamaCookieFilePath("acc-1")).toBeNull();
    expect(
      createOllamaCloudProvider({
        key: "account:acc-1",
        kind: "account",
        accountId: "acc-1",
        accountLabel: "個人用",
        authPath: null,
      }).isConfigured(),
    ).toBe(false);
    expect(
      createOllamaCloudProvider({
        key: "account:missing-path",
        kind: "account",
        accountId: null,
        accountLabel: "不正なスコープ",
        authPath: null,
      }).isConfigured(),
    ).toBe(false);

    // アカウント別 cookie を置くと、そのアカウントだけが設定済みになる
    const perAccount = join(configDir, "ollama_cookies.acc-1.txt");
    writeFileSync(perAccount, "# Netscape HTTP Cookie File\n", "utf8");
    expect(ollamaCookieFilePath("acc-1")).toBe(perAccount);
    expect(ollamaCookieFilePath("acc-2")).toBeNull();
  });
});

describe("parseOllamaHtml", () => {
  it("extracts session/weekly meters and reset times", () => {
    const html = `
      <span>Cloud usage</span><span>pro</span>
      <div id="header-email">user@ollama.com</div>
      <div aria-label="Session usage 12.5% used"></div>
      <div class="foo local-time" data-time="2026-08-21T10:00:00Z">Resets</div>
      <div aria-label="Weekly usage 40% used"></div>
      <div class="bar local-time" data-time="2026-08-28T00:00:00Z">Resets</div>
    `;
    const { windows, plan, accountEmail } = parseOllamaHtml(html);
    expect(plan).toBe("Pro");
    expect(accountEmail).toBe("user@ollama.com");
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      id: "ollama-session",
      title: "セッション",
      usedPercent: 12.5,
    });
    expect(windows[0].resetsAt?.toISOString()).toBe("2026-08-21T10:00:00.000Z");
    expect(windows[1]).toMatchObject({
      id: "ollama-weekly",
      title: "週間",
      usedPercent: 40,
    });
  });
});

describe("parseOpenCodeGoHtml", () => {
  it("parses hydration usage windows", () => {
    const now = new Date("2026-08-21T00:00:00Z");
    const html = `
      rollingUsage:$R[1]={usagePercent:10.5,resetInSec:3600}
      weeklyUsage:$R[2]={usagePercent:25,resetInSec:86400}
      monthlyUsage:$R[3]={usagePercent:50,resetInSec:2592000}
      only@example.com
    `;
    const { windows, accountEmail } = parseOpenCodeGoHtml(html, now);
    expect(accountEmail).toBe("only@example.com");
    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({
      id: "opencode-go-rolling",
      title: "ローリング",
      usedPercent: 10.5,
    });
    expect(windows[0].resetsAt?.toISOString()).toBe("2026-08-21T01:00:00.000Z");
    expect(windows[1].usedPercent).toBe(25);
    expect(windows[2].usedPercent).toBe(50);
  });
});

describe("OpenCode Go account cookie scope", () => {
  const previousAppData = process.env.APPDATA;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("keeps cookies and workspace IDs under the account auth directory", () => {
    const appData = mkdtempSync(join(tmpdir(), "leafcode-opencode-cookie-"));
    tempDirs.push(appData);
    process.env.APPDATA = appData;
    const authPath = join(appData, "agent", "accounts", "acc-1", "auth.json");
    const shared = join(appData, "CodexBar", "opencode_cookies.txt");
    mkdirSync(join(appData, "CodexBar"), { recursive: true });
    writeFileSync(
      shared,
      ".opencode.ai\tTRUE\t/\tTRUE\t4102444800\tsession\tshared\n",
      "utf8",
    );
    expect(
      createOpenCodeGoProvider({
        key: "account:missing-path",
        kind: "account",
        accountId: null,
        accountLabel: "不正なスコープ",
        authPath: null,
      }).isConfigured(),
    ).toBe(false);
    expect(extractOpenCodeCookieHeader({ authPath })).toBeNull();

    const cookieText =
      ".opencode.ai\tTRUE\t/\tTRUE\t4102444800\tsession\taccount\n";
    saveAccountOpenCodeCookieFile(authPath, cookieText);
    expect(accountOpenCodeCookiePath(authPath)).toContain(
      "opencode-cookies.txt",
    );
    expect(extractOpenCodeCookieHeader({ authPath })).toBe("session=account");
    expect(
      createOpenCodeGoProvider({
        key: "account:acc-1",
        kind: "account",
        accountId: "acc-1",
        accountLabel: "仕事用",
        authPath,
      }).isConfigured(),
    ).toBe(true);

    writeAccountOpenCodeGoWorkspace(authPath, "workspace-1");
    expect(readAccountOpenCodeGoWorkspace(authPath)).toBe("workspace-1");
    deleteAccountOpenCodeCookieFile(authPath);
    expect(extractOpenCodeCookieHeader({ authPath })).toBeNull();
  });
});

describe("qwen cloud parsers", () => {
  it("parses console DataV2 usage", () => {
    const subscriptionResponse = `{
      "data": { "DataV2": { "data": { "data": {
        "instanceCode": "instance-123",
        "specCode": "sfm_tokenplansolo_public_intl",
        "remainingDays": 300,
        "startTime": "2026-01-01T00:00:00Z",
        "endTime": "2027-01-01T00:00:00Z",
        "autoRenewFlag": true,
        "status": "VALID"
      } } } }
    }`;
    const usageResponse = `{ "data": { "DataV2": { "data": { "data": {
      "per5HourPercentage": 0.25,
      "per5HourResetTime": "2026-04-17T05:00:00Z",
      "per1WeekPercentage": "0.6",
      "per1WeekResetTime": "2026-04-21T00:00:00Z"
    } } } } }`;
    const snap = parseQwenConsoleUsage(subscriptionResponse, usageResponse);
    expect(snap.plan).toBe("Qwen Cloud Token Plan");
    expect(snap.windows).toHaveLength(2);
    expect(snap.windows[0]).toMatchObject({
      title: "5時間",
      usedPercent: 25,
    });
    expect(snap.windows[0].resetsAt?.toISOString()).toBe(
      "2026-04-17T05:00:00.000Z",
    );
    expect(snap.windows[1]).toMatchObject({
      title: "週間",
      usedPercent: 60,
    });
  });

  it("parses legacy API-key quota", () => {
    const legacyQuota = `{ "data": { "codingPlanInstanceInfos": [{ "status": "ACTIVE", "planName": "Qwen Coding Plan", "codingPlanQuotaInfo": { "per5HourUsedQuota": 25, "per5HourTotalQuota": 100, "per5HourQuotaNextRefreshTime": "2026-04-17T05:00:00Z" } }] } }`;
    const quota = parseQwenUsage(legacyQuota);
    expect(quota.plan).toBe("Qwen Coding Plan");
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0].usedPercent).toBe(25);
  });

  it("classifies login responses and extracts SEC_TOKEN", () => {
    expect(
      isQwenCloudLoginResponse(
        `{ "Code": "Unauthorized", "Message": "Need login" }`,
      ),
    ).toBe(true);
    expect(
      extractQwenCloudSecToken(
        `<script>window.ALIYUN_CONSOLE_CONFIG={SEC_TOKEN: "fixture-token"};</script>`,
      ),
    ).toBe("fixture-token");
  });

  it("builds console gateway form fields", () => {
    const form = buildQwenCloudForm("international", "fixture-token");
    expect(form).toContain("sec_token=fixture-token");
    expect(form).toContain("region=ap-southeast-1");
    const paramsPart = form
      .split("&")
      .find((p) => p.startsWith("params="))!
      .slice("params=".length);
    const params = JSON.parse(
      decodeURIComponent(paramsPart.replace(/\+/g, " ")),
    );
    expect(params.Api).toBe(
      "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription",
    );
    expect(params.Data.commodityCode).toBe("sfm_tokenplansolo_public_intl");
    expect(params.Data.cornerstoneParam.domain).toBe("home.qwencloud.com");

    const url = new URL(
      consoleApiUrl(
        "international",
        "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription",
      ),
    );
    expect(url.hostname).toBe("cs-data.qwencloud.com");
    expect(isQwenCloudCookieHostAllowed("cs-data.qwencloud.com")).toBe(true);
  });

  it("scopes Netscape Qwen cookies by request host", () => {
    const netscapeFixture = `# Netscape HTTP Cookie File
.example.com	TRUE	/	FALSE	4102444800	login_qwencloud_ticket	ignored-domain
.qwencloud.com	TRUE	/	TRUE	1	login_qwencloud_ticket	expired
#HttpOnly_.qwencloud.com	TRUE	/	TRUE	4102444800	login_qwencloud_ticket	domain-ticket
.qwencloud.com	TRUE	/	TRUE	4102444800	login_aliyunid_pk	domain-account
home.qwencloud.com	FALSE	/	FALSE	4102444800	host_only	exact-host
account.qwencloud.com	FALSE	/	FALSE	4102444800	account_host	account-only
.qwencloud.com	TRUE	/api	FALSE	4102444800	api_only	api-value
`;
    const session = parseQwenCloudNetscapeText(netscapeFixture);
    expect(session).not.toBeNull();
    const apiHeader = createCookieHeaderForUrl(
      session!,
      "https://home.qwencloud.com/api/data",
    );
    const otherHeader = createCookieHeaderForUrl(
      session!,
      "https://account.qwencloud.com/api/data",
    );
    const gatewayHeader = createCookieHeaderForUrl(
      session!,
      "https://cs-data.qwencloud.com/data/api.json",
    );
    expect(apiHeader).toContain("login_qwencloud_ticket=domain-ticket");
    expect(apiHeader).toContain("login_aliyunid_pk=domain-account");
    expect(apiHeader).toContain("host_only=exact-host");
    expect(apiHeader).toContain("api_only=api-value");
    expect(otherHeader).not.toContain("host_only=exact-host");
    expect(otherHeader).toContain("account_host=account-only");
    expect(gatewayHeader).toContain("login_qwencloud_ticket=domain-ticket");
    expect(gatewayHeader).not.toContain("host_only=exact-host");
    expect(gatewayHeader).not.toContain("api_only=api-value");
  });
});
