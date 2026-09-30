/** Trimmed generation, or "" when the value is absent or blank. */
export function normalizeExpectedGeneration(value: unknown): string;

/** Whether a running generation satisfies the expectation (no expectation matches anything). */
export function isBackendGenerationCompatible(expected: string, running: string | null | undefined): boolean;

/** `{ pinned, running, matches }` for diagnostics. */
export function runtimeGenerationStatus(
  expected: string | null | undefined,
  running: string | null | undefined,
): { pinned: string | null; running: string | null; matches: boolean };
