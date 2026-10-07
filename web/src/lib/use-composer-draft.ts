"use client";

import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import type { ComposerAttachment } from "@/components/Composer";

type ComposerDraft = {
  text: string;
  attachments: ComposerAttachment[];
};

const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };
// Page-lifetime only: layout changes must not discard drafts, but unsent text
// and attachment data must not be written to persistent browser storage.
const drafts = new Map<string, ComposerDraft>();
const listeners = new Map<string, Set<() => void>>();
const readDraft = (key: string): ComposerDraft => drafts.get(key) ?? EMPTY_DRAFT;

function updateDraft(key: string, update: (current: ComposerDraft) => ComposerDraft): void {
  const current = readDraft(key);
  const next = update(current);
  if (next.text === current.text && next.attachments === current.attachments) return;
  if (!next.text && next.attachments.length === 0) drafts.delete(key);
  else drafts.set(key, next);
  listeners.get(key)?.forEach((listener) => listener());
}

export function resetComposerDraftsForTests(): void {
  drafts.clear();
}

/** Stable, surface-scoped state even when a split/move remounts its view. */
export function useComposerDraft(key: string) {
  const subscribe = useCallback((listener: () => void) => {
    let subscribers = listeners.get(key);
    if (!subscribers) {
      subscribers = new Set();
      listeners.set(key, subscribers);
    }
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
      if (subscribers.size === 0) listeners.delete(key);
    };
  }, [key]);
  const getSnapshot = useCallback(() => readDraft(key), [key]);
  const draft = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_DRAFT);
  const setPrompt = useCallback((value: SetStateAction<string>) => {
    updateDraft(key, (current) => ({
      ...current,
      text: typeof value === "function" ? value(current.text) : value,
    }));
  }, [key]);
  const setAttachments = useCallback((value: SetStateAction<ComposerAttachment[]>) => {
    updateDraft(key, (current) => ({
      ...current,
      attachments: typeof value === "function" ? value(current.attachments) : value,
    }));
  }, [key]);
  const clearDraft = useCallback(() => updateDraft(key, () => EMPTY_DRAFT), [key]);
  return { prompt: draft.text, attachments: draft.attachments, setPrompt, setAttachments, clearDraft };
}
