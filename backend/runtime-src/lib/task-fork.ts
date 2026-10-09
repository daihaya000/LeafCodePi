import type { TaskSummary } from "@/lib/types";

export type ForkDraft = {
  text: string;
  images: { uri: string; mime: string; name?: string }[];
  files: { uri: string; mime: string; name?: string }[];
};
export type ForkTaskResult = ForkDraft & { task: TaskSummary };

const drafts = new Map<string, ForkDraft>();
const keyFor = (id: string) => `webui.fork-draft.${id}`;

/** Keep a memory fallback when browser storage is denied or attachments exceed its quota. */
export function saveForkDraft(id: string, draft: ForkDraft): void {
  drafts.set(id, draft);
  try { sessionStorage.setItem(keyFor(id), JSON.stringify(draft)); } catch { /* memory fallback */ }
}

export function takeForkDraft(id: string): ForkDraft | null {
  const memory = drafts.get(id);
  drafts.delete(id);
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(keyFor(id));
    sessionStorage.removeItem(keyFor(id));
  } catch { /* memory fallback */ }
  if (memory) return memory;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ForkDraft;
    if (typeof value.text !== "string" || !Array.isArray(value.images) || !Array.isArray(value.files) ||
      [...value.images, ...value.files].some((item) => !item || typeof item.uri !== "string" || typeof item.mime !== "string")) return null;
    return value;
  } catch { return null; }
}
