/**
 * 各プロバイダーの API URL（base URL）を保存する。
 * `provider-model-state.json` と同じ dataDir に `provider-endpoints.json` として保存。
 * 未保存／破損は各プロバイダーの既定値を返す。
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";

export const DEFAULT_OLLAMA_CLOUD_BASE = "https://ollama.com/v1";
export const REMOTE_PROVIDER_BASE = "https://z390-s01.tail3dc57b.ts.net/v1";

/** ユーザーが確認・変更できる API URL を持つプロバイダー。 */
export const BASE_URL_EDITABLE_PROVIDER_IDS = [
  "ollama-cloud",
  "leafcodecloud",
] as const;

export type ProviderEndpointId = (typeof BASE_URL_EDITABLE_PROVIDER_IDS)[number];
type ProviderEndpoints = Record<ProviderEndpointId, string>;

const DEFAULT_BASE_URL: ProviderEndpoints = {
  "ollama-cloud": DEFAULT_OLLAMA_CLOUD_BASE,
  leafcodecloud: REMOTE_PROVIDER_BASE,
};

function endpointPath(dir = dataDir()): string {
  return join(dir, "provider-endpoints.json");
}

function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function emptyEndpoints(): ProviderEndpoints {
  return { ...DEFAULT_BASE_URL };
}

function readStoredEndpoints(): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(endpointPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[provider-endpoints] failed to read", error);
    }
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readProviderEndpoints(): ProviderEndpoints {
  const stored = readStoredEndpoints();
  const result = emptyEndpoints();
  for (const providerId of BASE_URL_EDITABLE_PROVIDER_IDS) {
    const baseUrl = normalizeBaseUrl(stored[providerId]);
    if (baseUrl) result[providerId] = baseUrl;
  }
  return result;
}

/** 既定、または保存済みの上書き値を返す。 */
export function effectiveBaseUrl(providerId: string): string {
  return isEditableBaseUrlProvider(providerId)
    ? readProviderEndpoints()[providerId]
    : "";
}

export function isEditableBaseUrlProvider(
  providerId: string,
): providerId is ProviderEndpointId {
  return (BASE_URL_EDITABLE_PROVIDER_IDS as readonly string[]).includes(
    providerId,
  );
}

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
    throw error;
  }
}

export function setProviderBaseUrl(
  providerId: string,
  baseUrl: string,
): void {
  if (!isEditableBaseUrlProvider(providerId)) {
    throw Object.assign(
      new Error("API URL を変更できるプロバイダーではありません"),
      { status: 400 },
    );
  }
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    throw Object.assign(
      new Error("http:// または https:// で始まる URL を指定してください"),
      { status: 400 },
    );
  }
  const stored = readStoredEndpoints();
  stored[providerId] = normalized;
  // 未知のキーはそのまま残し、既知の providerId だけ更新する。
  atomicWrite(endpointPath(), `${JSON.stringify(stored, null, 2)}\n`);
}
