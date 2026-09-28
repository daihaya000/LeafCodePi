/**
 * Keep each provider request within its image budget.
 *
 * Pi resends every image in the conversation on each request, so long sessions
 * (`read` of screenshots, tool captures, pasted files) keep growing. Providers
 * cap the count per request: after a Claude/GPT session switched to DeepSeek
 * V4.1 Flash, every turn failed with "Too many images in request: 54 > 30".
 * The hook runs before each model call and only shapes that request; the
 * session history keeps every image.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Budget when the model declares none: the smallest limit seen from a mainstream upstream (DeepSeek). */
export const DEFAULT_REQUEST_IMAGE_LIMIT = 30;

/** Stands in for each run of omitted images. Constant, so repeated requests stay identical. */
export const OMITTED_IMAGE_TEXT =
  "[画像を省略: 1リクエストの画像数上限を超えた古い画像です。必要なら取得し直してください]";

type ImageLimitModel = {
  provider?: string;
  id?: string;
  inputLimits?: { images?: { maxPerRequest?: number } };
};
type ContentBlock = { type?: unknown; text?: unknown };

const LEARNED_LIMITS_KEY = "__leafcodeRequestImageLimits" as const;

/** Shared by every route bundle of the server process. */
function learnedLimits(): Map<string, number> {
  const globalRef = globalThis as typeof globalThis & {
    [LEARNED_LIMITS_KEY]?: Map<string, number>;
  };
  globalRef[LEARNED_LIMITS_KEY] ??= new Map();
  return globalRef[LEARNED_LIMITS_KEY];
}

const modelKey = (provider: string, modelId: string) => `${provider}\0${modelId}`;

const isLimit = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

/** @internal テスト用。学習した上限を破棄する。 */
export function __resetRequestImageLimitsForTests(): void {
  learnedLimits().clear();
}

/** The declared `inputLimits.images.maxPerRequest` or the default, lowered by a limit the provider reported. */
export function requestImageLimit(model: ImageLimitModel | undefined): number {
  const declared = model?.inputLimits?.images?.maxPerRequest;
  const base = isLimit(declared) ? declared : DEFAULT_REQUEST_IMAGE_LIMIT;
  const learned =
    model?.provider && model.id
      ? learnedLimits().get(modelKey(model.provider, model.id))
      : undefined;
  return learned === undefined ? base : Math.min(base, learned);
}

function imageCount(message: object): number {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content as ContentBlock[]) {
    if (block?.type === "image") count++;
  }
  return count;
}

/**
 * Replace the oldest images with a text note so at most `limit` remain.
 *
 * Trimming advances in steps of half the limit: the omitted prefix, and with it
 * the provider's prompt cache, changes once per step instead of on every new
 * image. Returns `messages` itself when nothing changes; never mutates input.
 */
export function capRequestImages<T extends object>(messages: T[], limit: number): T[] {
  let total = 0;
  for (const message of messages) total += imageCount(message);
  if (total <= limit) return messages;
  const step = Math.max(1, Math.floor(limit / 2));
  let omit = Math.min(total, Math.ceil((total - limit) / step) * step);
  return messages.map((message) => {
    if (omit === 0 || imageCount(message) === 0) return message;
    const content: ContentBlock[] = [];
    for (const block of (message as { content: ContentBlock[] }).content) {
      if (omit > 0 && block?.type === "image") {
        omit--;
        if (content.at(-1)?.text !== OMITTED_IMAGE_TEXT) {
          content.push({ type: "text", text: OMITTED_IMAGE_TEXT });
        }
        continue;
      }
      content.push(block);
    }
    return { ...message, content } as T;
  });
}

/** Digit groups first, so "3,000" is not read as 3. */
const COUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
const LIMIT_PAIR = new RegExp(String.raw`\d[\d,]*\s*>\s*${COUNT}`);
const LIMIT_PHRASE = new RegExp(
  String.raw`(?:max(?:imum)?|limit|up to|at most|no more than)(?:\s+(?:is|of|allowed))*\s*[:=]?\s*${COUNT}`,
  "i",
);

/** The limit stated by a "too many images" provider error, e.g. "Too many images in request: 54 > 30". */
export function parseImageLimitError(errorMessage: string): number | undefined {
  const start = errorMessage.search(/too many images/i);
  if (start < 0) return undefined;
  const detail = errorMessage.slice(start);
  const match = LIMIT_PAIR.exec(detail) ?? LIMIT_PHRASE.exec(detail);
  const limit = match ? Number(match[1].replaceAll(",", "")) : Number.NaN;
  return isLimit(limit) ? limit : undefined;
}

/** Remember a lower limit reported by the provider, so the next request to that model fits. */
export function learnRequestImageLimit(
  provider: string | undefined,
  modelId: string | undefined,
  errorMessage: string | undefined,
): number | undefined {
  if (!provider || !modelId || !errorMessage) return undefined;
  const limit = parseImageLimitError(errorMessage);
  if (limit === undefined) return undefined;
  const key = modelKey(provider, modelId);
  const known = learnedLimits().get(key);
  if (known !== undefined && known <= limit) return known;
  learnedLimits().set(key, limit);
  console.warn(
    `[leafcode-pi] ${provider}/${modelId} accepts at most ${limit} images per request; older images are omitted from now on`,
  );
  return limit;
}

/** Session extension: cap images per request and learn tighter limits from provider errors. */
export function registerRequestImageCap(api: ExtensionAPI): void {
  // Not `context`: a changed conversation there makes Pi fold mid-conversation
  // prompt/tool updates into a new leading system message, which invalidates the
  // whole cached prefix. Here system messages stay put and only image blocks
  // change; it also runs after every `context` handler, so it sees the final images.
  api.on("context_with_system", (event, ctx) => {
    const model = ctx.model;
    // Text-only models already get placeholders from pi-ai (or the provider wrapper).
    if (model && !model.input.includes("image")) return undefined;
    const messages = capRequestImages(event.messages, requestImageLimit(model));
    return messages === event.messages ? undefined : { messages };
  });
  api.on("message_end", (event) => {
    const message = event.message;
    if (message.role === "assistant" && message.stopReason === "error") {
      learnRequestImageLimit(message.provider, message.model, message.errorMessage);
    }
  });
}
