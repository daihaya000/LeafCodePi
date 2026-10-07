export const MAX_SESSION_LOAD_BYTES: number;
export const MIN_SESSION_LOAD_RESERVE_BYTES: number;
export const SESSION_LOAD_EXPANSION_FACTOR: number;
export interface RuntimeMemory {
  heapUsed: number;
  heapLimit: number;
  rss: number;
  external: number;
  arrayBuffers: number;
}
export function readRuntimeMemory(): RuntimeMemory;
export function isRuntimeMemoryPressure(memory: Pick<RuntimeMemory, "heapUsed" | "heapLimit">): boolean;
export function assertSessionLoadAllowed(file?: string | null, options?: {
  readMemory?: () => Pick<RuntimeMemory, "heapUsed" | "heapLimit">;
  stat?: (file: string) => { size: number };
}): void;
