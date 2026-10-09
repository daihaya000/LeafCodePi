export const SESSION_INDEX_MAX_BYTES: number;
export const SESSION_PAGE_MAX_BYTES: number;
export type SessionIndexMetadata = Record<string, string | number | boolean | null>;
export type SessionIndexRow<M extends SessionIndexMetadata> = M & { id: string; parentId: string | null; offset: number; length: number };
export function readIndexedSession<M extends SessionIndexMetadata, S extends { ids: string[] }>(path: string, options: {
  kind: string;
  classify(entry: any): M;
  select(branch: readonly SessionIndexRow<M>[]): S;
  signal?: AbortSignal;
}): Promise<{ entries: any[]; selection: S }>;
export function resetSessionLogIndex(): void;
export function sessionLogIndexDiagnostics(): { scannedBytes: number; parsedRows: number; selectedBytes: number; cacheHits: number; branchBuilds: number; descriptors: number; cacheBytes: number; cacheEntries: number; readers: number; waiters: number };
