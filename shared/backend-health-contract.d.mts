export type BackendHealth = { ok: boolean; engine: "pi"; engineOk: boolean; version: string | null; modelCount: number; error?: string | null; startedAt?: number; platform?: string; dataDir?: string; warnings?: string[] };
export function publicBackendHealthBody(value: unknown, status?: number, authorized?: boolean): BackendHealth | { error: string } | null;
