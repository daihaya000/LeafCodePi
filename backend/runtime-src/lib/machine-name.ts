import { hostname } from "node:os";

/** Use the first DNS label so an FQDN still produces a machine-name suffix. */
export function normalizeMachineName(value: string): string {
  const firstLabel = value.trim().split(".", 1)[0]?.toLowerCase() ?? "";
  const normalized = firstLabel
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return normalized || "unknown";
}

export function getMachineName(): string {
  return normalizeMachineName(hostname());
}
