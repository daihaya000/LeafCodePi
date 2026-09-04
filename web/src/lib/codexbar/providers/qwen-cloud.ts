/**
 * Qwen Cloud token-plan usage.
 * Prefer Netscape browser session; fall back to API key (Coding Plan API).
 */

import { randomUUID } from "node:crypto";
import {
  ProviderError,
  type IUsageProvider,
  type RateWindow,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  cleanApiKey,
  clamp,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";
import {
  createCookieHeaderForUrl,
  extractQwenCloudSession,
  type BrowserCookieSession,
} from "@/lib/codexbar/browser-cookies";
import {
  loadCodexBarConfig,
  readConfigString,
} from "@/lib/codexbar/codexbar-config";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const BROWSER_LOGIN_REQUIRED =
  "Qwen Cloud の利用状況を取得するには、Chrome または Edge で QwenCloud にログインするか、Netscape cookie / API キーを設定してください。";
const CONSOLE_PRODUCT = "sfm_bailian";
const SUBSCRIPTION_API =
  "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const QWEN_REQUEST_HOSTS = new Set([
  "home.qwencloud.com",
  "cs-data.qwencloud.com",
]);

export type QwenCloudRegion = "international" | "chinaMainland";

type QwenFailureKind = "generic" | "credentials" | "loginRequired";

class QwenProviderFailure extends Error {
  constructor(
    message: string,
    readonly retryOtherRegion: boolean,
    readonly kind: QwenFailureKind,
  ) {
    super(message);
    this.name = "QwenProviderFailure";
  }
}

export function displayRegionName(region: QwenCloudRegion): string {
  return region === "chinaMainland" ? "China mainland" : "International";
}

export function dashboardUrl(): string {
  return "https://home.qwencloud.com/billing/subscription/token-plan-individual";
}

export function gatewayBaseUrl(): string {
  return "https://home.qwencloud.com";
}

export function currentRegionId(region: QwenCloudRegion): string {
  return region === "chinaMainland" ? "cn-hangzhou" : "ap-southeast-1";
}

export function consoleApiUrl(region: QwenCloudRegion, api: string): string {
  const action =
    region === "chinaMainland"
      ? "BroadScopeAspnGateway"
      : "IntlBroadScopeAspnGateway";
  return `https://cs-data.qwencloud.com/data/api.json?product=${CONSOLE_PRODUCT}&action=${action}&api=${encodeURIComponent(api)}&_v=undefined`;
}

function subscriptionCommodityCode(region: QwenCloudRegion): string {
  return region === "chinaMainland"
    ? "sfm_tokenplansolo_public_cn"
    : "sfm_tokenplansolo_public_intl";
}

function legacyCommodityCode(region: QwenCloudRegion): string {
  return region === "chinaMainland"
    ? "sfm_codingplan_public_cn"
    : "sfm_codingplan_public_intl";
}

function legacyGatewayBaseUrl(region: QwenCloudRegion): string {
  return region === "chinaMainland"
    ? "https://bailian.console.aliyun.com"
    : "https://modelstudio.console.alibabacloud.com";
}

function legacyQuotaUrl(region: QwenCloudRegion): string {
  const regionId =
    region === "chinaMainland" ? "cn-beijing" : "ap-southeast-1";
  return `${legacyGatewayBaseUrl(region)}/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=${regionId}`;
}

function prettyPlan(raw: string): string {
  if (
    raw.toLowerCase() === "sfm_tokenplansolo_public_intl" ||
    raw.toLowerCase() === "sfm_tokenplansolo_public_cn"
  ) {
    return "Qwen Cloud Token Plan";
  }
  return raw;
}

export function resolveQwenCloudRegion(): QwenCloudRegion {
  const configured = readConfigString(loadCodexBarConfig(), "qwenCloudRegion");
  const value = cleanApiKey(configured);
  if (
    value?.toLowerCase() === "cn" ||
    value?.toLowerCase() === "chinamainland"
  ) {
    return "chinaMainland";
  }
  return "international";
}

export function resolveQwenCloudApiKey(): string | null {
  const fromConfig = cleanApiKey(
    readConfigString(loadCodexBarConfig(), "qwenCloudApiKey"),
  );
  if (fromConfig) return fromConfig;
  for (const key of [
    "ALIBABA_QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
    "ALIBABA_CODING_PLAN_API_KEY",
  ]) {
    const v = cleanApiKey(process.env[key]);
    if (v) return v;
  }
  return null;
}

function emptyCredits(): Pick<
  UsageSnapshot,
  | "creditsBalance"
  | "creditsLabel"
  | "creditsEnabled"
  | "creditsTitle"
  | "creditsUsed"
  | "creditsLimit"
  | "rateLimitResetCreditsAvailable"
> {
  return {
    creditsBalance: null,
    creditsLabel: null,
    creditsEnabled: false,
    creditsTitle: null,
    creditsUsed: null,
    creditsLimit: null,
    rateLimitResetCreditsAvailable: null,
  };
}

// ---- JSON helpers (ExpandJsonStrings + deep search) ----

function expandJsonNode(node: unknown): unknown {
  if (typeof node === "string") {
    const trimmed = node.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return expandJsonNode(JSON.parse(node));
      } catch {
        return node;
      }
    }
    return node;
  }
  if (Array.isArray(node)) return node.map(expandJsonNode);
  const obj = asRecord(node);
  if (!obj) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = expandJsonNode(v);
  }
  return out;
}

function expandJsonStrings(body: string): unknown {
  return expandJsonNode(JSON.parse(body));
}

function tryGetProperty(
  element: unknown,
  keys: string[],
): unknown | undefined {
  const obj = asRecord(element);
  if (!obj) return undefined;
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

function getString(element: unknown, key: string): string | null {
  const obj = asRecord(element);
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return new Date(value);
    if (value > 1_000_000_000) return new Date(value * 1000);
    return null;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

function findFirstDate(root: unknown, keys: string[]): Date | null {
  const obj = asRecord(root);
  if (!obj) return null;
  for (const key of keys) {
    if (key in obj) {
      const d = parseDate(obj[key]);
      if (d) return d;
    }
  }
  for (const v of Object.values(obj)) {
    if (asRecord(v)) {
      const found = findFirstDate(v, keys);
      if (found) return found;
    }
  }
  return null;
}

function findFirstInt(root: unknown, keys: string[]): number | null {
  const obj = asRecord(root);
  if (!obj) return null;
  for (const key of keys) {
    if (key in obj) {
      const v = obj[key];
      if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return Math.trunc(n);
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (asRecord(v)) {
      const found = findFirstInt(v, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

function findFirstDouble(root: unknown, keys: string[]): number | null {
  const obj = asRecord(root);
  if (!obj) return null;
  for (const key of keys) {
    if (key in obj) {
      const n = flexibleNumber(obj[key]);
      if (n !== null) return n;
    }
  }
  for (const v of Object.values(obj)) {
    if (asRecord(v)) {
      const found = findFirstDouble(v, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

function findFirstString(root: unknown, keys: string[]): string | null {
  const obj = asRecord(root);
  if (obj) {
    for (const key of keys) {
      const t = getString(obj, key);
      if (t && t.length > 0) return t;
    }
    for (const v of Object.values(obj)) {
      const found = findFirstString(v, keys);
      if (found) return found;
    }
  } else if (Array.isArray(root)) {
    for (const item of root) {
      const found = findFirstString(item, keys);
      if (found) return found;
    }
  }
  return null;
}

function findFirstObjectContainingAnyKey(
  root: unknown,
  keys: string[],
): Record<string, unknown> | null {
  const obj = asRecord(root);
  if (obj) {
    if (keys.some((k) => k in obj)) return obj;
    for (const v of Object.values(obj)) {
      const found = findFirstObjectContainingAnyKey(v, keys);
      if (found) return found;
    }
  } else if (Array.isArray(root)) {
    for (const item of root) {
      const found = findFirstObjectContainingAnyKey(item, keys);
      if (found) return found;
    }
  }
  return null;
}

function payloadDiagnostics(data: unknown): string {
  const obj = asRecord(data);
  if (obj) {
    return `topKeys=${Object.keys(obj).sort().join(",")}`;
  }
  return `kind=${Array.isArray(data) ? "array" : typeof data}`;
}

function isErrorStatus(value: unknown): boolean {
  if (typeof value === "number") return value !== 0 && value !== 200;
  if (value === true) return false;
  if (value === false) return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  const code = Number(text);
  if (Number.isFinite(code) && text !== "") {
    return code !== 0 && code !== 200;
  }
  const upper = text.toUpperCase();
  return !(
    upper === "OK" ||
    upper === "SUCCESS" ||
    upper === "VALID" ||
    upper === "ACTIVE" ||
    upper === "RUNNING" ||
    upper === "NORMAL"
  );
}

function findErrorMessage(root: unknown): string | null {
  const obj = asRecord(root);
  if (!obj) return null;
  for (const key of [
    "errorMessage",
    "error_message",
    "message",
    "Message",
    "msg",
    "errorMsg",
  ]) {
    const m = getString(obj, key);
    if (m && m.length > 0) return m;
  }
  return null;
}

function isQwenCloudLogin(status: unknown, message: string): boolean {
  const combined = `${String(status)} ${message}`;
  return /need login|not login|unauthorized/i.test(combined);
}

function findApiError(
  root: unknown,
): { message: string; retryOtherRegion: boolean; kind: QwenFailureKind } | null {
  const obj = asRecord(root);
  if (obj) {
    for (const key of ["statusCode", "status_code", "code", "Code", "Success"]) {
      if (!(key in obj)) continue;
      if (!isErrorStatus(obj[key])) continue;
      const message =
        findErrorMessage(obj) ?? "Qwen Cloud の要求に失敗しました。";
      const login = isQwenCloudLogin(obj[key], message);
      return {
        message: login ? BROWSER_LOGIN_REQUIRED : message,
        retryOtherRegion: login,
        kind: login ? "loginRequired" : "generic",
      };
    }
    for (const v of Object.values(obj)) {
      const found = findApiError(v);
      if (found) return found;
    }
  } else if (Array.isArray(root)) {
    for (const item of root) {
      const found = findApiError(item);
      if (found) return found;
    }
  }
  return null;
}

export function isQwenCloudLoginResponse(body: string): boolean {
  try {
    const err = findApiError(expandJsonStrings(body));
    return err?.kind === "loginRequired";
  } catch {
    return /need login/i.test(body) || /login/i.test(body);
  }
}

export function extractQwenCloudSecToken(html: string): string | null {
  for (const pattern of [
    /SEC_TOKEN\s*:\s*"([^"]+)"/,
    /["']SEC_TOKEN["']\s*:\s*["']([^"']+)["']/,
  ]) {
    const match = pattern.exec(html);
    if (match?.[1]?.trim()) return match[1];
  }
  return null;
}

function getPayloadData(root: unknown): unknown {
  const obj = asRecord(root);
  if (!obj) return root;
  if (asRecord(obj.data) || Array.isArray(obj.data)) return obj.data;
  if (asRecord(obj.Data) || Array.isArray(obj.Data)) return obj.Data;
  return root;
}

function unwrapConsoleData(root: unknown): unknown {
  let current = root;
  for (const keys of [
    ["data", "Data"],
    ["DataV2", "dataV2"],
    ["data", "Data"],
    ["data", "Data"],
  ]) {
    const next = tryGetProperty(current, keys);
    if (next === undefined) break;
    if (!asRecord(next) && !Array.isArray(next)) break;
    current = next;
  }
  return current;
}

function isActiveSubscription(subscription: Record<string, unknown>): boolean {
  const status = tryGetProperty(subscription, ["status", "Status"]);
  return (
    typeof status === "string" && status.toUpperCase() === "VALID"
  );
}

function findInstanceArray(root: unknown): unknown[] | null {
  if (Array.isArray(root)) return root;
  const obj = asRecord(root);
  if (!obj) return null;
  for (const key of [
    "codingPlanInstanceInfos",
    "coding_plan_instance_infos",
    "Data",
    "data",
    "Instances",
    "instances",
  ]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  for (const v of Object.values(obj)) {
    const found = findInstanceArray(v);
    if (found) return found;
  }
  return null;
}

function activeSignalScore(info: Record<string, unknown>): number {
  const status = tryGetProperty(info, ["status", "Status", "instanceStatus"]);
  if (typeof status === "string") {
    const text = status.toUpperCase();
    if (["VALID", "ACTIVE", "RUNNING", "NORMAL"].includes(text)) return 3;
    if (
      [
        "EXPIRED",
        "INVALID",
        "INACTIVE",
        "DISABLED",
        "TERMINATED",
        "STOPPED",
      ].includes(text)
    ) {
      return -1;
    }
  }
  const end = tryGetProperty(info, [
    "instanceEndTime",
    "endTime",
    "expireTime",
    "expirationTime",
  ]);
  const expiry = parseDate(end);
  if (expiry && expiry.getTime() > Date.now()) return 1;
  return 0;
}

function findActiveInstanceInfo(
  data: unknown,
): Record<string, unknown> | null {
  const instances = findInstanceArray(data);
  if (!instances) return null;
  let first: Record<string, unknown> | null = null;
  let best: Record<string, unknown> | null = null;
  let bestScore = Number.MIN_SAFE_INTEGER;
  for (const item of instances) {
    const obj = asRecord(item);
    if (!obj) continue;
    first ??= obj;
    const score = activeSignalScore(obj);
    if (score > bestScore) {
      best = obj;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : first;
}

function findQuotaInfo(
  data: unknown,
  instance: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (instance) {
    const direct = tryGetProperty(instance, [
      "codingPlanQuotaInfo",
      "coding_plan_quota_info",
    ]);
    if (asRecord(direct)) return asRecord(direct);
  }
  return findFirstObjectContainingAnyKey(data, [
    "codingPlanQuotaInfo",
    "coding_plan_quota_info",
    "per5HourUsedQuota",
    "perWeekUsedQuota",
    "perBillMonthUsedQuota",
  ]);
}

function findPlanName(
  instance: Record<string, unknown> | null,
  data: unknown,
): string | null {
  if (instance) {
    for (const key of [
      "planName",
      "PlanName",
      "instanceName",
      "InstanceName",
      "packageName",
      "ProductCode",
      "CommodityCode",
    ]) {
      const name = getString(instance, key);
      if (name && name.length > 0) return name;
    }
  }
  return findFirstString(data, [
    "planName",
    "PlanName",
    "packageName",
    "ProductCode",
    "CommodityCode",
  ]);
}

function addQuotaWindow(
  windows: RateWindow[],
  quota: Record<string, unknown>,
  id: string,
  title: string,
  usedKeys: string[],
  totalKeys: string[],
  resetKeys: string[],
  durationMs: number,
  countsTowardLimit: boolean,
): void {
  const used = findFirstInt(quota, usedKeys);
  const total = findFirstInt(quota, totalKeys);
  if (used === null || total === null || total <= 0) return;
  windows.push({
    id,
    title,
    usedPercent: clamp((used / total) * 100, 0, 100),
    resetsAt: findFirstDate(quota, resetKeys),
    windowDurationMs: durationMs,
    countsTowardLimit,
  });
}

function buildQuotaWindows(quota: Record<string, unknown>): RateWindow[] {
  const windows: RateWindow[] = [];
  addQuotaWindow(
    windows,
    quota,
    "qwen-cloud-5h",
    "5時間",
    ["per5HourUsedQuota", "perFiveHourUsedQuota"],
    ["per5HourTotalQuota", "perFiveHourTotalQuota"],
    ["per5HourQuotaNextRefreshTime", "perFiveHourQuotaNextRefreshTime"],
    5 * 3600_000,
    true,
  );
  addQuotaWindow(
    windows,
    quota,
    "qwen-cloud-weekly",
    "週間",
    ["perWeekUsedQuota"],
    ["perWeekTotalQuota"],
    ["perWeekQuotaNextRefreshTime"],
    7 * 86400_000,
    true,
  );
  addQuotaWindow(
    windows,
    quota,
    "qwen-cloud-monthly",
    "月間",
    ["perBillMonthUsedQuota", "perMonthUsedQuota"],
    ["perBillMonthTotalQuota", "perMonthTotalQuota"],
    ["perBillMonthQuotaNextRefreshTime", "perMonthQuotaNextRefreshTime"],
    30 * 86400_000,
    false,
  );
  return windows;
}

function buildSubscriptionWindows(
  instance: Record<string, unknown> | null,
): RateWindow[] {
  if (!instance) return [];
  const start = findFirstDate(instance, [
    "instanceStartTime",
    "instance_start_time",
    "startTime",
    "beginTime",
  ]);
  const end = findFirstDate(instance, [
    "instanceEndTime",
    "instance_end_time",
    "endTime",
    "expireTime",
    "expirationTime",
  ]);
  if (!start || !end || end.getTime() <= start.getTime()) return [];
  const durationMs = end.getTime() - start.getTime();
  const usedPercent = clamp(
    ((Date.now() - start.getTime()) / durationMs) * 100,
    0,
    100,
  );
  return [
    {
      id: "qwen-cloud-subscription",
      title: "サブスクリプション",
      usedPercent,
      resetsAt: end,
      windowDurationMs: durationMs,
      countsTowardLimit: true,
    },
  ];
}

function addPercentageWindow(
  windows: RateWindow[],
  usage: unknown,
  id: string,
  title: string,
  percentageKey: string,
  resetKey: string,
  durationMs: number,
): void {
  const percentage = findFirstDouble(usage, [percentageKey]);
  if (percentage === null) return;
  windows.push({
    id,
    title,
    usedPercent: clamp(percentage * 100, 0, 100),
    resetsAt: findFirstDate(usage, [resetKey]),
    windowDurationMs: durationMs,
    countsTowardLimit: true,
  });
}

/** Exported for tests — legacy Coding Plan API body. */
export function parseQwenUsage(
  body: string,
  region: QwenCloudRegion = "international",
  authMode: "apiKey" | "webSession" = "apiKey",
): UsageSnapshot {
  const root = expandJsonStrings(body);
  const error = findApiError(root);
  if (error) {
    throw new QwenProviderFailure(
      error.message,
      error.retryOtherRegion,
      error.kind,
    );
  }

  const data = getPayloadData(root);
  const instance = findActiveInstanceInfo(data);
  const quota = findQuotaInfo(data, instance);
  const windows = quota
    ? buildQuotaWindows(quota)
    : buildSubscriptionWindows(instance);
  if (windows.length === 0) {
    throw new QwenProviderFailure(
      `Qwen Cloud の利用可能なプランが見つかりません (${payloadDiagnostics(data)})`,
      true,
      "generic",
    );
  }

  const plan = findPlanName(instance, data) ?? "Qwen Cloud Token Plan";
  return {
    providerId: "qwen-cloud",
    providerName: "Qwen Cloud",
    plan: prettyPlan(plan),
    accountEmail: null,
    windows,
    ...emptyCredits(),
    sourceLabel:
      authMode === "webSession"
        ? `QwenCloud 請求ページ (${displayRegionName(region)})`
        : `Coding Plan API (${displayRegionName(region)})`,
    updatedAt: new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

/** Exported for tests — console subscription + usage JSON. */
export function parseQwenConsoleUsage(
  subscriptionBody: string,
  usageBody: string | null,
  region: QwenCloudRegion = "international",
): UsageSnapshot {
  const subscriptionRoot = expandJsonStrings(subscriptionBody);
  const subscriptionError = findApiError(subscriptionRoot);
  if (subscriptionError) {
    throw new QwenProviderFailure(
      subscriptionError.message,
      subscriptionError.retryOtherRegion,
      subscriptionError.kind,
    );
  }

  const subscriptionData = unwrapConsoleData(subscriptionRoot);
  const subscription = findFirstObjectContainingAnyKey(subscriptionData, [
    "instanceCode",
    "specCode",
    "remainingDays",
    "autoRenewFlag",
  ]);
  if (!subscription || !isActiveSubscription(subscription)) {
    throw new QwenProviderFailure(
      `Qwen Cloud の有効なサブスクリプション情報を取得できませんでした (${payloadDiagnostics(subscriptionData)})`,
      false,
      "generic",
    );
  }

  let windows: RateWindow[] = [];
  if (usageBody?.trim()) {
    try {
      const usageRoot = expandJsonStrings(usageBody);
      if (!findApiError(usageRoot)) {
        const usage = unwrapConsoleData(usageRoot);
        addPercentageWindow(
          windows,
          usage,
          "qwen-cloud-5h",
          "5時間",
          "per5HourPercentage",
          "per5HourResetTime",
          5 * 3600_000,
        );
        addPercentageWindow(
          windows,
          usage,
          "qwen-cloud-weekly",
          "週間",
          "per1WeekPercentage",
          "per1WeekResetTime",
          7 * 86400_000,
        );
      }
    } catch {
      /* fall through to subscription windows */
    }
  }

  if (windows.length === 0) {
    windows = buildSubscriptionWindows(subscription);
  }
  if (windows.length === 0) {
    throw new QwenProviderFailure(
      `Qwen Cloud の利用状況を解析できませんでした (${payloadDiagnostics(subscriptionData)})`,
      false,
      "generic",
    );
  }

  const plan =
    findFirstString(subscription, ["specCode", "commodityCode", "planName"]) ??
    "Qwen Cloud Token Plan";

  return {
    providerId: "qwen-cloud",
    providerName: "Qwen Cloud",
    plan: prettyPlan(plan),
    accountEmail: null,
    windows,
    ...emptyCredits(),
    sourceLabel: `QwenCloud 請求ページ (${displayRegionName(region)})`,
    updatedAt: new Date(),
    isStale: false,
    rateLimitResetCreditsAvailable: null,
  };
}

export function buildQwenCloudForm(
  region: QwenCloudRegion,
  secToken: string,
  api: string = SUBSCRIPTION_API,
): string {
  const data: Record<string, unknown> = {
    cornerstoneParam: {
      domain: "home.qwencloud.com",
      consoleSite: "QWENCLOUD",
      console: "ONE_CONSOLE",
      xsp_lang: "en-US",
      protocol: "V2",
      productCode: "p_efm",
      feTraceId: randomUUID(),
      feURL: dashboardUrl(),
    },
  };
  if (api === SUBSCRIPTION_API) {
    data.commodityCode = subscriptionCommodityCode(region);
  }
  const params = { Api: api, V: "1.0", Data: data };
  const body = new URLSearchParams({
    sec_token: secToken,
    region: currentRegionId(region),
    params: JSON.stringify(params),
  });
  return body.toString();
}

export function isQwenCloudCookieHostAllowed(host: string): boolean {
  return QWEN_REQUEST_HOSTS.has(host.toLowerCase());
}

async function fetchFromApi(
  apiKey: string,
  region: QwenCloudRegion,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const payload = {
    queryCodingPlanInstanceInfoRequest: {
      commodityCode: legacyCommodityCode(region),
    },
  };
  const { status, body, ok } = await fetchText(legacyQuotaUrl(region), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "X-DashScope-API-Key": apiKey,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Origin: legacyGatewayBaseUrl(region),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!ok) {
    const credentials = status === 401 || status === 403;
    throw new QwenProviderFailure(
      credentials
        ? "Qwen Cloud の API キーが無効か期限切れです。"
        : `Qwen Cloud API エラー HTTP ${status}。`,
      credentials || status === 404,
      credentials ? "credentials" : "generic",
    );
  }
  return parseQwenUsage(body, region, "apiKey");
}

async function fetchFromApiWithRegionFallback(
  apiKey: string,
  region: QwenCloudRegion,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  if (region === "chinaMainland") {
    return fetchFromApi(apiKey, region, signal);
  }
  try {
    return await fetchFromApi(apiKey, region, signal);
  } catch (err) {
    if (err instanceof QwenProviderFailure && err.retryOtherRegion) {
      return fetchFromApi(apiKey, "chinaMainland", signal);
    }
    throw err;
  }
}

async function fetchConsoleGateway(
  session: BrowserCookieSession,
  region: QwenCloudRegion,
  secToken: string,
  api: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = consoleApiUrl(region, api);
  const host = new URL(url).hostname;
  if (!isQwenCloudCookieHostAllowed(host)) {
    throw new Error("QwenCloud の許可済みホスト以外にはブラウザ Cookie を送信できません。");
  }
  const cookieHeader = createCookieHeaderForUrl(session, url);
  if (!cookieHeader) {
    throw new QwenProviderFailure(
      BROWSER_LOGIN_REQUIRED,
      false,
      "loginRequired",
    );
  }

  const { status, body, ok } = await fetchText(url, {
    method: "POST",
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": USER_AGENT,
      Origin: gatewayBaseUrl(),
      Referer: dashboardUrl(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: buildQwenCloudForm(region, secToken, api),
    signal,
    redirect: "manual",
  });

  if (status >= 300 && status <= 399) {
    throw new QwenProviderFailure(
      BROWSER_LOGIN_REQUIRED,
      false,
      "loginRequired",
    );
  }
  if (!ok) {
    const loginRequired =
      status === 401 || status === 403 || isQwenCloudLoginResponse(body);
    throw new QwenProviderFailure(
      loginRequired
        ? BROWSER_LOGIN_REQUIRED
        : `QwenCloud API が HTTP ${status} を返しました。`,
      loginRequired,
      loginRequired ? "loginRequired" : "generic",
    );
  }
  return body;
}

async function fetchFromQwenCloudConsole(
  session: BrowserCookieSession,
  region: QwenCloudRegion,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const dash = dashboardUrl();
  const cookieHeader = createCookieHeaderForUrl(session, dash);
  if (!cookieHeader) {
    throw new QwenProviderFailure(
      BROWSER_LOGIN_REQUIRED,
      false,
      "loginRequired",
    );
  }

  const page = await fetchText(dash, {
    headers: {
      Cookie: cookieHeader,
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal,
    redirect: "manual",
  });

  if (page.status >= 300 && page.status <= 399) {
    throw new QwenProviderFailure(
      BROWSER_LOGIN_REQUIRED,
      false,
      "loginRequired",
    );
  }
  if (!page.ok) {
    const login = page.status === 401 || page.status === 403;
    throw new QwenProviderFailure(
      login
        ? BROWSER_LOGIN_REQUIRED
        : `QwenCloud の請求ページが HTTP ${page.status} を返しました。`,
      login,
      login ? "loginRequired" : "generic",
    );
  }

  const secToken = extractQwenCloudSecToken(page.body);
  if (!secToken) {
    throw new QwenProviderFailure(
      BROWSER_LOGIN_REQUIRED,
      true,
      "loginRequired",
    );
  }

  const subscriptionBody = await fetchConsoleGateway(
    session,
    region,
    secToken,
    SUBSCRIPTION_API,
    signal,
  );
  let usageBody: string | null = null;
  try {
    usageBody = await fetchConsoleGateway(
      session,
      region,
      secToken,
      USAGE_API,
      signal,
    );
  } catch (err) {
    if (err instanceof QwenProviderFailure && err.kind === "loginRequired") {
      throw err;
    }
  }

  const snapshot = parseQwenConsoleUsage(subscriptionBody, usageBody, region);
  return {
    ...snapshot,
    sourceLabel: `QwenCloud 請求ページ (${session.sourceLabel})`,
  };
}

export const qwenCloudProvider: IUsageProvider = {
  id: "qwen-cloud",
  name: "Qwen Cloud",
  isConfigured() {
    return (
      extractQwenCloudSession() !== null || resolveQwenCloudApiKey() !== null
    );
  },
  async fetch(signal) {
    const region = resolveQwenCloudRegion();
    const apiKey = resolveQwenCloudApiKey();
    const session = extractQwenCloudSession();

    try {
      if (session) {
        try {
          return await fetchFromQwenCloudConsole(session, region, signal);
        } catch (err) {
          if (
            err instanceof QwenProviderFailure &&
            err.kind === "loginRequired" &&
            apiKey
          ) {
            return await fetchFromApiWithRegionFallback(apiKey, region, signal);
          }
          throw err;
        }
      }

      if (apiKey) {
        return await fetchFromApiWithRegionFallback(apiKey, region, signal);
      }

      throw new QwenProviderFailure(
        BROWSER_LOGIN_REQUIRED,
        false,
        "loginRequired",
      );
    } catch (err) {
      if (err instanceof QwenProviderFailure) {
        throw new ProviderError(err.message, { cause: err });
      }
      if (err instanceof SyntaxError) {
        throw new ProviderError("Qwen Cloud の応答を解析できませんでした。", {
          cause: err,
        });
      }
      throw err;
    }
  },
};
