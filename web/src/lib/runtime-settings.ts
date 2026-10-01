import {
  getCompactionSettings as readCompactionLocally,
  setCompactionEnabled as setCompactionLocally,
  getCacheWarmingMode as readWarmingLocally,
  setCacheWarmingMode as setWarmingLocally,
  refreshCompactionSuggestions as refreshLocally,
  applyCodePermissionSettingsToLiveTasks as applyPermissionsLocally,
} from "@/lib/pi/harness";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { controlBackendRuntime } from "@/lib/backend-client";
import type { CacheWarmingMode } from "@/lib/compaction-settings";
export { jsonError } from "@/lib/pi/harness";

async function remote<T>(action: string, value?: unknown): Promise<T> {
  const result = await controlBackendRuntime<T>(action, value);
  if (!result.ok) throw Object.assign(new Error("Backendの設定を取得・更新できません"), { status: 503 });
  return result.body.result;
}
export async function getCompactionSettings(): Promise<Awaited<ReturnType<typeof readCompactionLocally>>> {
  return localRuntimeBlocked() ? remote("read-compaction") : readCompactionLocally();
}
export async function setCompactionEnabled(enabled: boolean): Promise<Awaited<ReturnType<typeof setCompactionLocally>>> {
  return localRuntimeBlocked() ? remote("set-compaction", enabled) : setCompactionLocally(enabled);
}
export async function getCacheWarmingMode(): Promise<CacheWarmingMode> {
  return localRuntimeBlocked() ? remote("read-cache-warming") : readWarmingLocally();
}
export async function setCacheWarmingMode(mode: CacheWarmingMode): Promise<CacheWarmingMode> {
  return localRuntimeBlocked() ? remote("set-cache-warming", mode) : setWarmingLocally(mode);
}
export async function refreshCompactionSuggestions(): Promise<void> {
  if (localRuntimeBlocked()) await remote("refresh-compaction");
  else refreshLocally();
}
export async function applyCodePermissionSettingsToLiveTasks(): Promise<void> {
  if (localRuntimeBlocked()) await remote("code-permissions");
  else await applyPermissionsLocally();
}
