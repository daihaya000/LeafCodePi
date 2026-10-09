import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";

const MISSING_TERMINAL = "OpenAI Responses stream ended before a terminal response event";
const MAX_BUFFER_EVENTS = 8_192;
const MAX_BUFFER_CHARS = 65_536;

type StreamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/**
 * Retry one prematurely closed Responses stream, only before any answer/tool output.
 * Hold early reasoning so a failed attempt cannot duplicate it on replay. Once an
 * answer/tool starts, or the bounded buffer fills, forward normally without retry.
 * Never synthesize success for an incomplete response or execute partial tools.
 */
export function withCommandCodeStreamRetry(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.streamSimple !== "function") return config;
  const inner = config.streamSimple as StreamSimple;
  return {
    ...config,
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
      // The package uses a custom API id; its Responses-only compat marker identifies the wire.
      const compat = ((model as Model<Api> & { compatConfig?: { sessionAffinityFormat?: string } }).compatConfig ?? model.compat) as
        { sessionAffinityFormat?: string } | undefined;
      if (model.api !== "openai-responses" && compat?.sessionAffinityFormat !== "openai-nosession") {
        return inner(model, context, options);
      }
      const output = new AssistantMessageEventStream();
      const run = async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const buffered: AssistantMessageEvent[] = [];
          let chars = 0;
          let canRetry = true;
          let retry = false;
          const flush = () => {
            for (const event of buffered) output.push(event);
            buffered.length = 0;
          };
          for await (const event of inner(model, context, options)) {
            if (event.type === "error") {
              const hasAnswerOrTool = event.error.content.some((block) => block.type === "toolCall" ||
                (block.type === "text" && block.text.length > 0));
              if (attempt === 0 && canRetry && !hasAnswerOrTool && !options?.signal?.aborted &&
                event.reason !== "aborted" && event.error.errorMessage === MISSING_TERMINAL) {
                retry = true;
                break;
              }
              flush();
              output.push(event);
              return;
            }
            if (event.type === "done") {
              flush();
              output.push(event);
              return;
            }
            if (event.type !== "start" && !event.type.startsWith("thinking_")) {
              canRetry = false;
              flush();
            }
            if (!canRetry) {
              output.push(event);
              continue;
            }
            buffered.push(event);
            if (event.type === "thinking_delta") chars += event.delta.length;
            if (event.type === "thinking_end") chars = Math.max(chars, event.content.length);
            if (buffered.length >= MAX_BUFFER_EVENTS || chars >= MAX_BUFFER_CHARS) {
              canRetry = false;
              flush();
            }
          }
          if (retry) continue;
          flush();
          throw new Error("Command Code stream ended without a terminal event");
        }
      };
      void run().catch((error: unknown) => {
        output.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: options?.signal?.aborted ? "aborted" : "error", timestamp: Date.now(),
          errorMessage: error instanceof Error ? error.message : String(error),
        } });
      }).finally(() => output.end());
      return output;
    },
  };
}
