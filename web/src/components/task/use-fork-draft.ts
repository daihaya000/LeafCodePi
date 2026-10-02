"use client";

import { useLayoutEffect, useRef } from "react";
import type { ComposerAttachment } from "@/components/Composer";
import { takeForkDraft, type ForkDraft } from "@/lib/task-fork";

/** Call after the task-switch reset effect. Keep its draft stable under StrictMode effect replay. */
export function useForkDraft(
  taskId: string,
  setText: (value: string) => void,
  setAttachments: (value: ComposerAttachment[]) => void,
): void {
  const restored = useRef<{ id: string; draft: ForkDraft | null } | null>(null);
  useLayoutEffect(() => {
    if (restored.current?.id !== taskId) restored.current = { id: taskId, draft: takeForkDraft(taskId) };
    const draft = restored.current.draft;
    if (!draft) return;
    setText(draft.text);
    setAttachments([...draft.images, ...draft.files]);
  }, [taskId, setText, setAttachments]);
}
