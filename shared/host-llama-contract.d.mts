export const HOST_LLAMA_PATH: string;
export const HOST_LLAMA_HEADER: string;
export const HOST_LLAMA_OPERATION_HEADER: string;
export const HOST_LLAMA_BODY_LIMIT: number;
export const HOST_LLAMA_RESPONSE_LIMIT: number;
export const HOST_LLAMA_ROUTES: Readonly<Record<string, readonly string[]>>;
export function publicHostLlamaBody(action: string, value: unknown, status: number): Record<string, unknown> | null;
