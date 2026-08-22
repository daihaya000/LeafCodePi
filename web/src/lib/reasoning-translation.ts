import { useEffect, useState } from "react";

export type ReasoningTranslationMode = "original" | "translated" | "bilingual";

const STORAGE_KEY = "webui:reasoning-translation-mode";
const OVERRIDE_EVENT = "webui:reasoning-translation-override";
const TRANSLATION_DEBOUNCE_MS = 600;
const BATCH_WINDOW_MS = 20;
const MAX_BATCH_ITEMS = 16;
const MAX_BATCH_CHARS = 16_000;
const cache = new Map<string, string>();

type TranslationResult = {
  translation: string;
  fallback: boolean;
};

type Subscriber = {
  active: boolean;
  resolve: (result: TranslationResult | null) => void;
};

type TranslationWork = {
  text: string;
  subscribers: Set<Subscriber>;
  timer: number | null;
  queued: boolean;
  inFlight: boolean;
};

/**
 * ReasoningView is rendered once per reasoning part. Sending one HTTP request
 * from every view made opening a long session produce dozens of simultaneous
 * requests, even though the host and the BFF both support batches of 16.
 * Keep one small client-side queue so a session switch cannot flood the local
 * translation process or the WebUI event loop.
 */
const workByText = new Map<string, TranslationWork>();
const readyQueue: TranslationWork[] = [];
let flushTimer: number | null = null;
let activeBatch = false;
let schedulerGeneration = 0;

function finishWork(
  work: TranslationWork,
  result: TranslationResult | null,
): void {
  if (workByText.get(work.text) !== work) return;
  workByText.delete(work.text);
  work.inFlight = false;
  for (const subscriber of work.subscribers) {
    if (!subscriber.active) continue;
    subscriber.active = false;
    subscriber.resolve(result);
  }
  work.subscribers.clear();
}

function scheduleFlush(delayMs = BATCH_WINDOW_MS): void {
  if (flushTimer !== null || activeBatch || readyQueue.length === 0) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    runNextBatch();
  }, delayMs);
}

function takeBatch(): TranslationWork[] {
  const batch: TranslationWork[] = [];
  let chars = 0;
  const leftover: TranslationWork[] = [];

  while (readyQueue.length > 0 && batch.length < MAX_BATCH_ITEMS) {
    const work = readyQueue.shift()!;
    if (
      workByText.get(work.text) !== work ||
      !work.queued ||
      work.subscribers.size === 0
    ) {
      continue;
    }

    work.queued = false;
    if (work.text.length > MAX_BATCH_CHARS) {
      finishWork(work, null);
      continue;
    }

    if (batch.length > 0 && chars + work.text.length > MAX_BATCH_CHARS) {
      leftover.push(work);
      continue;
    }

    work.inFlight = true;
    chars += work.text.length;
    batch.push(work);
  }

  // Put skipped work back at the front in original order for the next batch.
  readyQueue.unshift(...leftover);
  return batch;
}

function runNextBatch(): void {
  if (activeBatch) return;
  const batch = takeBatch();
  if (batch.length === 0) {
    if (readyQueue.length > 0 && flushTimer === null) scheduleFlush(0);
    return;
  }

  activeBatch = true;
  const generation = schedulerGeneration;
  const texts = batch.map((work) => work.text);
  void fetch("/api/translation/reasoning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) return null;
      return (await response.json()) as {
        translations?: unknown;
        fallbacks?: unknown;
      };
    })
    .then((body) => {
      if (!body || !Array.isArray(body.translations)) {
        for (const work of batch) finishWork(work, null);
        return;
      }

      for (const [index, work] of batch.entries()) {
        const raw = body.translations[index];
        const translation = typeof raw === "string" ? raw.trim() : "";
        const fallback =
          Array.isArray(body.fallbacks) && body.fallbacks[index] === true;
        if (!translation) {
          finishWork(work, null);
          continue;
        }
        if (!fallback) cache.set(work.text, translation);
        finishWork(work, { translation, fallback });
      }
    })
    .catch(() => {
      for (const work of batch) finishWork(work, null);
    })
    .finally(() => {
      if (generation !== schedulerGeneration) return;
      activeBatch = false;
      if (readyQueue.length > 0) scheduleFlush(0);
    });
}

function requestReasoningTranslation(text: string): {
  promise: Promise<TranslationResult | null>;
  cancel: () => void;
} {
  const cached = cache.get(text);
  if (cached) {
    return {
      promise: Promise.resolve({ translation: cached, fallback: false }),
      cancel: () => {},
    };
  }

  let work = workByText.get(text);
  if (!work) {
    work = {
      text,
      subscribers: new Set(),
      timer: null,
      queued: false,
      inFlight: false,
    };
    workByText.set(text, work);
    work.timer = window.setTimeout(() => {
      work!.timer = null;
      if (workByText.get(text) !== work || work!.subscribers.size === 0) {
        if (workByText.get(text) === work) workByText.delete(text);
        return;
      }
      work!.queued = true;
      readyQueue.push(work!);
      scheduleFlush();
    }, TRANSLATION_DEBOUNCE_MS);
  }

  let subscriber!: Subscriber;
  const promise = new Promise<TranslationResult | null>((resolve) => {
    subscriber = { active: true, resolve };
    work!.subscribers.add(subscriber);
  });
  const cancel = () => {
    if (!subscriber.active) return;
    subscriber.active = false;
    work!.subscribers.delete(subscriber);
    subscriber.resolve(null);
    if (work!.subscribers.size > 0 || work!.inFlight) return;
    if (work!.timer !== null) {
      window.clearTimeout(work!.timer);
      work!.timer = null;
    }
    if (workByText.get(text) === work) workByText.delete(text);
  };
  return { promise, cancel };
}

/** Test-only reset for the module-level scheduler and cache. */
export function __resetReasoningTranslationForTest(): void {
  schedulerGeneration += 1;
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const work of workByText.values()) {
    if (work.timer !== null) window.clearTimeout(work.timer);
    for (const subscriber of work.subscribers) {
      if (!subscriber.active) continue;
      subscriber.active = false;
      subscriber.resolve(null);
    }
  }
  workByText.clear();
  readyQueue.length = 0;
  activeBatch = false;
  cache.clear();
}

export function readReasoningTranslationMode(): ReasoningTranslationMode {
  if (typeof window === "undefined") return "translated";
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "original" || value === "bilingual" || value === "translated"
    ? value
    : "translated";
}

export function writeReasoningTranslationMode(mode: ReasoningTranslationMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent("webui:reasoning-translation-mode"));
}

export async function saveReasoningTranslationOverride(
  text: string,
  translation: string,
): Promise<string> {
  const corrected = translation.trim();
  if (!text.trim() || !corrected) throw new Error("原文と修正訳を入力してください");
  if (text.length > 16_000 || corrected.length > 16_000) {
    throw new Error("修正訳が長すぎます");
  }
  const response = await fetch("/api/translation/override", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, translation: corrected }),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    translation?: unknown;
  };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "修正訳を保存できませんでした");
  }
  const saved = typeof body.translation === "string" ? body.translation.trim() : corrected;
  cache.set(text, saved);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OVERRIDE_EVENT, {
      detail: { text, translation: saved },
    }));
  }
  return saved;
}

function looksJapanese(text: string): boolean {
  const japanese = text.match(/[ぁ-ゖァ-ヺ一-龯々〆〄]/g)?.length ?? 0;
  return japanese >= 2 && japanese / Math.max(text.length, 1) > 0.08;
}

/**
 * Split a reasoning text into translatable segments while preserving code.
 *
 * - Fenced code blocks (```...```) are kept verbatim and never translated.
 * - Inline code spans (`...`) are replaced with placeholders during
 *   translation and restored afterwards, so a sentence that mentions
 *   `variantEnabled` is translated as prose without mangling the identifier.
 * - Paragraphs that already look Japanese are kept verbatim.
 * - Empty/whitespace-only segments are preserved to maintain line breaks.
 *
 * The returned value is a tuple of [displayText, segments]. `displayText`
 * replaces inline code with placeholders so the translator sees natural
 * prose; `segments` records, for each segment, whether it should be
 * translated and the placeholder map needed to restore inline code.
 */
type Segment = {
  /** Original text of this segment (placeholders substituted for inline code). */
  text: string;
  /** Whether this segment should be sent to the translator. */
  translate: boolean;
  /** Inline-code placeholders that must be restored after translation. */
  placeholders: Map<string, string>;
};

type SegmentPlan = {
  segments: Segment[];
};

const FENCE_RE = /(^|\n)(`{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;

function buildSegmentPlan(text: string): SegmentPlan {
  const segments: Segment[] = [];
  let lastEnd = 0;

  // Carve out fenced code blocks first; everything between them is prose.
  for (const match of text.matchAll(FENCE_RE)) {
    const matchStart = match.index ?? 0;
    const proseSlice = text.slice(lastEnd, matchStart);
    if (proseSlice) {
      segments.push(...proseSegmentPlan(proseSlice).segments);
    }
    const fenceSlice = match[0];
    segments.push({
      text: fenceSlice,
      translate: false,
      placeholders: new Map(),
    });
    lastEnd = matchStart + fenceSlice.length;
  }

  const tail = text.slice(lastEnd);
  if (tail) {
    segments.push(...proseSegmentPlan(tail).segments);
  }

  return { segments };
}

function proseSegmentPlan(prose: string): SegmentPlan {
  // Split on blank-line paragraph boundaries while keeping the separators so
  // the join restores the original layout. Single newlines stay inside a
  // paragraph because reasoning prose often wraps manually.
  const parts = prose.split(/(\n{2,})/);
  const segments: Segment[] = [];
  let placeholderCounter = 0;

  for (const part of parts) {
    if (!part) continue;
    // Whitespace-only separators are kept verbatim and skipped.
    if (!part.trim()) {
      segments.push({ text: part, translate: false, placeholders: new Map() });
      continue;
    }

    // Substitute inline code with stable placeholders.
    let display = part;
    const localPlaceholders = new Map<string, string>();
    display = display.replace(INLINE_CODE_RE, (_m, code: string) => {
      const key = `\u0001${placeholderCounter++}\u0001`;
      localPlaceholders.set(key, code);
      return key;
    });

    const shouldTranslate = !looksJapanese(display);
    segments.push({
      text: display,
      translate: shouldTranslate,
      placeholders: localPlaceholders,
    });
  }

  return { segments };
}

function restoreInlineCode(text: string, placeholders: Map<string, string>): string {
  if (placeholders.size === 0) return text;
  return text.replace(/\u0001\d+\u0001/g, (m) => {
    const code = placeholders.get(m);
    return code === undefined ? m : `\`${code}\``;
  });
}

/**
 * Reassemble translated segments while restoring inline-code placeholders.
 * Untranslated segments (code blocks, Japanese paragraphs, separators) are
 * spliced back from the original plan.
 */
function assembleTranslation(
  plan: SegmentPlan,
  translatedSegments: Map<number, string>,
): string {
  const result: string[] = [];
  plan.segments.forEach((segment, index) => {
    if (segment.translate) {
      const translated = translatedSegments.get(index);
      if (translated !== undefined) {
        result.push(restoreInlineCode(translated, segment.placeholders));
        return;
      }
    }
    result.push(restoreInlineCode(segment.text, segment.placeholders));
  });
  return result.join("");
}

export function useReasoningTranslation(text: string): {
  mode: ReasoningTranslationMode;
  translated: string | null;
  pending: boolean;
} {
  const [mode, setMode] = useState<ReasoningTranslationMode>(readReasoningTranslationMode);
  const [translated, setTranslated] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const update = () => setMode(readReasoningTranslationMode());
    window.addEventListener("webui:reasoning-translation-mode", update);
    return () => window.removeEventListener("webui:reasoning-translation-mode", update);
  }, []);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown; translation?: unknown }>).detail;
      if (detail?.text !== text || typeof detail.translation !== "string") return;
      setTranslated(detail.translation);
      setPending(false);
    };
    window.addEventListener(OVERRIDE_EVENT, update);
    return () => window.removeEventListener(OVERRIDE_EVENT, update);
  }, [text]);

  useEffect(() => {
    let cancelled = false;
    const requests: { cancel: () => void }[] = [];
    setTranslated(null);
    setPending(false);
    if (mode === "original" || !text.trim()) return;

    const plan = buildSegmentPlan(text);
    const translatable = plan.segments
      .map((segment, index) => ({ segment, index }))
      .filter((entry) => entry.segment.translate);

    if (translatable.length === 0) return;

    setPending(true);

    const translatedSegments = new Map<number, string>();
    let remaining = translatable.length;

    const commit = () => {
      if (cancelled) return;
      if (remaining > 0) return;
      setTranslated(assembleTranslation(plan, translatedSegments));
      setPending(false);
    };

    for (const { segment, index } of translatable) {
      const request = requestReasoningTranslation(segment.text);
      requests.push(request);
      void request.promise.then((result) => {
        if (cancelled) return;
        if (result && !result.fallback && result.translation) {
          translatedSegments.set(index, result.translation);
        }
        remaining -= 1;
        commit();
      });
    }

    return () => {
      cancelled = true;
      for (const request of requests) request.cancel();
    };
  }, [mode, text]);

  return { mode, translated, pending };
}
