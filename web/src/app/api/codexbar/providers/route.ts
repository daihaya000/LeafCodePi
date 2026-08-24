import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { clearCachedUsage } from "@/lib/codexbar/cache";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import { codexBarConfigPath } from "@/lib/codexbar/codexbar-config";
import {
  catalog,
  isKnownProviderId,
  LEAFCODE_PROVIDER_ORDER_KEY,
  PROVIDER_CATALOG,
  ProviderConfigError,
  readProviderConfig,
  serializeProviderIds,
  versionOf,
  type ProviderId,
} from "@/lib/codexbar/provider-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCK_RETRY_COUNT = 25;
const LOCK_RETRY_DELAY_MS = 20;

function configLockPath(): string {
  return `${codexBarConfigPath()}.providers.lock`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireConfigLock(): Promise<() => Promise<void>> {
  const lockFile = configLockPath();
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      return async () => {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockFile).catch(() => undefined);
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "EEXIST" || attempt === LOCK_RETRY_COUNT - 1) {
        throw new ProviderConfigError("CodexBar の設定更新をロックできません");
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new ProviderConfigError("CodexBar の設定更新をロックできません");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function safeError(error: unknown, status = 503): Response {
  const message =
    error instanceof ProviderConfigError
      ? error.message
      : "CodexBar の設定を更新できません";
  return json({ error: message }, status);
}

type UpdateRequest =
  | {
      providerId: ProviderId;
      enabled: boolean;
      version: string;
    }
  | {
      providerOrder: ProviderId[];
      version: string;
    };

function isUpdateRequest(value: unknown): value is UpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (typeof body.version !== "string") return false;

  if (
    keys.length === 2 &&
    keys.every((key) => key === "providerOrder" || key === "version") &&
    Array.isArray(body.providerOrder)
  ) {
    const order = body.providerOrder;
    return (
      order.length === PROVIDER_CATALOG.length &&
      new Set(order).size === order.length &&
      order.every((id) => typeof id === "string" && isKnownProviderId(id))
    );
  }

  return (
    keys.length === 3 &&
    keys.every(
      (key) => key === "providerId" || key === "enabled" || key === "version",
    ) &&
    typeof body.providerId === "string" &&
    isKnownProviderId(body.providerId) &&
    typeof body.enabled === "boolean"
  );
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  const file = codexBarConfigPath();
  await fs.mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/** Safe catalog only: no credentials leave this process. */
export async function GET() {
  try {
    const current = await readProviderConfig();
    return json({
      providers: catalog(current.enabled, current.order),
      version: versionOf(current.text),
    });
  } catch (error) {
    return safeError(error);
  }
}

/**
 * Update provider enablement or order. Preserves every other config key.
 * Missing config.json is treated as "{}" so the first PUT can succeed.
 */
export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON 本文が不正です" }, 400);
  }
  if (!isUpdateRequest(body)) {
    return json(
      { error: "providerId、enabled または providerOrder と version を指定してください" },
      400,
    );
  }

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquireConfigLock();
    const current = await readProviderConfig();
    if (versionOf(current.text) !== body.version) {
      return json(
        { error: "設定が他で変更されました。再読み込みしてください" },
        409,
      );
    }

    if ("providerOrder" in body) {
      const updated = {
        ...current.config,
        enabledProviders: serializeProviderIds(current.enabled, current.config),
        [LEAFCODE_PROVIDER_ORDER_KEY]: body.providerOrder,
      };
      await writeConfig(updated);
      clearCachedUsage();
      const text = `${JSON.stringify(updated, null, 2)}\n`;
      return json({
        providers: catalog(current.enabled, body.providerOrder),
        version: versionOf(text),
      });
    }

    const next = new Set(current.enabled);
    if (body.enabled) next.add(body.providerId);
    else next.delete(body.providerId);
    if (next.size === 0) {
      return json(
        { error: "少なくとも 1 つのプロバイダーを有効にしてください" },
        400,
      );
    }

    const enabled = current.order.filter((id) => next.has(id));
    const updated: Record<string, unknown> = {
      ...current.config,
      enabledProviders: serializeProviderIds(enabled, current.config),
    };
    await writeConfig(updated);
    clearCachedUsage();
    clearProviderCache();
    const text = `${JSON.stringify(updated, null, 2)}\n`;
    return json({
      providers: catalog(enabled, current.order),
      version: versionOf(text),
    });
  } catch (error) {
    return safeError(error);
  } finally {
    await releaseLock?.();
  }
}
