import { isAbsolutePath } from "@/lib/paths";

export type QuickAccessItem = { name: string; path: string };

/** PowerShell の Shell namespace JSON を安全なファイルシステム項目へ絞り込む。 */
export function parseWindowsQuickAccess(output: string): QuickAccessItem[] {
  try {
    const parsed = JSON.parse(output.trim().replace(/^\uFEFF/, "")) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as { name?: unknown; path?: unknown };
      if (
        typeof value.name !== "string" ||
        typeof value.path !== "string" ||
        !value.name.trim() ||
        !isAbsolutePath(value.path.trim())
      ) return [];
      return [{ name: value.name.trim(), path: value.path.trim() }];
    });
  } catch {
    return [];
  }
}
