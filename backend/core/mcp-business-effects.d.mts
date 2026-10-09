export function markMcpBusinessEffect(): void;
export function withMcpBusinessEffects<T>(work: (started: () => boolean) => T): T;
