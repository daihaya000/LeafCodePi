export const TASK_FILE_STREAM_PATH: string;
export const TASK_FILE_ROUTES: Readonly<Record<string, readonly string[]>>;
export const FILE_STREAM_HEADERS: readonly string[];
export function taskFileTarget(route: string): { route: string; id: string; kind: "media" | "image" | "files" | "images" | "project-icon" | "preview-image"; file?: string } | null;
