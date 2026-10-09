export const HOST_BUILD_INFO_PATH: string;
export const HOST_BUILD_INFO_HEADER: string;
export const HOST_BUILD_OPERATION_HEADER: string;
export const HOST_BUILD_INFO_BODY_LIMIT: number;
export type HostBuildInfo = { commit?: string | null; committedAt?: string | null; latestCommit?: string | null; error?: string; operation?: { id: string; execution: "not-started" | "complete" | "unknown" } };
export function publicHostBuildInfo(value: unknown, status: number): HostBuildInfo | null;
