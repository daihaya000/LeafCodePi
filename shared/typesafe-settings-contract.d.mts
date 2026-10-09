export const TYPESAFE_SETTINGS_ROUTES: Readonly<Record<string, readonly string[]>>;
export function typesafeSettingsTarget(path: string): { route: string; params: Record<string, string> } | null;
export function typesafeSettingsBodyLimit(path: string, method?: string): number;
export function publicTypesafeSettingsBody(route: string, value: unknown, status: number, method?: string): Record<string, unknown> | null;
