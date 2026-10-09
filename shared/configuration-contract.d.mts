export const CONFIGURATION_PATH: string;
export const CONFIGURATION_ROUTES: Readonly<Record<string, readonly string[]>>;
export const CONFIGURATION_HEADERS: Readonly<{origin: string; host: string; authorized: string; operation: string}>;
export type ConfigurationMutation = { operationId: string; saved: boolean | null; saveStatus: "complete" | "partial" | "none" | "unknown"; revision: string | null; apply: "applied" | "deferred" | "failed" | "not-required" | "unknown"; recovery: "none" | "restored" | "required" | "unknown" };
export function configurationBodyLimit(route: string, method: string): number;
export function configurationTarget(path: string): {route: string; params: Record<string, string>} | null;
export function publicConfigurationMutation(value: unknown): ConfigurationMutation | null;
