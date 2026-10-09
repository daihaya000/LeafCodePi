export const SERVICE_BUSINESS_ROUTES: Readonly<Record<string, readonly string[]>>;
export const PREVIEW_IMAGE_LIMIT: number;
export function serviceBusinessTarget(route: string): {route: string; params: Record<string,string>} | null;
export function serviceBusinessBodyLimit(route: string): number;
export function publicServiceBusinessBody(route: string, value: unknown, status: number): Record<string, unknown> | null;
