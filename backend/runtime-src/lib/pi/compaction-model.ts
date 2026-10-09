import { isThinkingLevel } from "@/lib/thinking-levels";
import type { ThinkingLevel } from "@/lib/types";

/** A resolved compaction model; release() returns any held account runtime. */
export type CompactionModelRoute<TModel, TStreamFn> = {
  model: TModel;
  streamFn: TStreamFn;
  release: () => void;
};

/**
 * Summarize with the configured compaction model. Returns undefined to keep Pi's
 * default summary (session model) when unset, unresolvable, aborted, or failed.
 */
export async function compactWithConfiguredModel<TModel, TStreamFn, TResult>(options: {
  value: string | null | undefined;
  effort: string | null | undefined;
  signal: AbortSignal;
  resolve: (value: string) => Promise<CompactionModelRoute<TModel, TStreamFn> | undefined>;
  compact: (
    model: TModel,
    streamFn: TStreamFn,
    thinkingLevel: ThinkingLevel | undefined,
  ) => Promise<TResult>;
  onError?: (error: unknown) => void;
}): Promise<TResult | undefined> {
  const value = options.value?.trim();
  if (!value || options.signal.aborted) return undefined;
  let route: CompactionModelRoute<TModel, TStreamFn> | undefined;
  try {
    route = await options.resolve(value);
    if (!route) throw new Error(`コンパクションモデルが見つかりません: ${value}`);
    const thinkingLevel = isThinkingLevel(options.effort) ? options.effort : undefined;
    return await options.compact(route.model, route.streamFn, thinkingLevel);
  } catch (error) {
    if (!options.signal.aborted) options.onError?.(error);
    return undefined;
  } finally {
    route?.release();
  }
}
