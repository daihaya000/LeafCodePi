/**
 * Keep each provider request within the model's image limit.
 *
 * Pi resends every image in the conversation on each request, so long sessions
 * (`read` of screenshots, tool captures, pasted files) keep growing, and each
 * route caps the count differently: Claude takes 100 or 600, OpenAI 1,500, but
 * OpenCode Go's DeepSeek upstream rejected "Too many images in request: 54 > 30".
 * The hook only shapes the outgoing request; the session history keeps every image.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stands in for each run of omitted images. Constant, so repeated requests stay identical. */
export const OMITTED_IMAGE_TEXT =
  "[画像を省略: モデルの1リクエストあたりの画像数上限を超えたため、古い順に省略しました。必要なら取得し直してください]";

/** Appended to a provider error that taught a new limit. No digits or English, so it never looks retryable. */
export const LIMIT_LEARNED_NOTE = "（この画像数の上限を記録し、以降は古い画像を省略して送ります）";

/** Automatic resends per failing streak; each one also needs a strictly lower limit. */
export const MAX_AUTO_RETRIES = 3;

type ImageLimitModel = {
  provider?: string;
  id?: string;
  api?: string;
  contextWindow?: number;
  inputLimits?: { images?: { maxPerRequest?: number } };
};
type KnownLimit = {
  provider?: string;
  api?: string;
  model?: RegExp;
  limit: number | ((model: ImageLimitModel) => number);
};
type ContentBlock = { type?: unknown; text?: unknown };

/** Documented limits of first-party APIs and limits observed on specific routes. First match wins. */
const KNOWN_LIMITS: readonly KnownLimit[] = [
  // Observed 2026-09-29 ("54 > 30"); the DeepSeek API itself accepts 600.
  { provider: "opencode-go", model: /deepseek/i, limit: 30 },
  // Bedrock Converse: "You can include up to 20 images."
  { api: "bedrock-converse-stream", limit: 20 },
  // Anthropic: 100 per request for models with a 200k-token context window, 600 for all others.
  { model: /claude/i, limit: (model) => ((model.contextWindow ?? 0) > 200_000 ? 600 : 100) },
  // OpenAI: up to 1,500 images per request.
  { model: /(?:^|[/~])(?:(?:chat)?gpt-|o\d+(?:-|$)|codex)/i, limit: 1_500 },
  // Gemini: up to 3,000 images per prompt.
  { model: /gemini/i, limit: 3_000 },
  // DeepSeek API: up to 600 images per request.
  { model: /deepseek/i, limit: 600 },
];

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

function knownImageLimit(model: ImageLimitModel): number | undefined {
  const rule = KNOWN_LIMITS.find(
    (candidate) =>
      (candidate.provider === undefined || candidate.provider === model.provider) &&
      (candidate.api === undefined || candidate.api === model.api) &&
      (candidate.model === undefined || candidate.model.test(model.id ?? "")),
  );
  if (!rule) return undefined;
  return typeof rule.limit === "function" ? rule.limit(model) : rule.limit;
}

/**
 * Images one request may carry: the declared `inputLimits.images.maxPerRequest`,
 * else the known limit of the route, lowered by a limit the provider reported.
 * `undefined` means no known limit, so nothing is omitted.
 */
export function requestImageLimit(model: ImageLimitModel | undefined): number | undefined {
  if (!model) return undefined;
  const declared = model.inputLimits?.images?.maxPerRequest;
  const base = isLimit(declared) ? declared : knownImageLimit(model);
  const learned =
    model.provider && model.id ? learnedLimits().get(modelKey(model.provider, model.id)) : undefined;
  if (learned === undefined) return base;
  return base === undefined ? learned : Math.min(base, learned);
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

export function countRequestImages(messages: readonly object[]): number {
  let total = 0;
  for (const message of messages) total += imageCount(message);
  return total;
}

/**
 * Replace the oldest images with a text note so at most `limit` remain.
 *
 * Trimming advances in blocks of a fifth of the limit: at least 80% of the
 * limit is still sent, and the omitted prefix, with it the provider's prompt
 * cache, changes once per block instead of on every new image. Returns
 * `messages` itself when nothing changes; never mutates input.
 */
export function capRequestImages<T extends object>(messages: T[], limit: number): T[] {
  const total = countRequestImages(messages);
  if (total <= limit) return messages;
  const step = Math.max(1, Math.floor(limit / 5));
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

/** Rejections for the image count, not an image's size, dimensions or tokens. */
const IMAGE_COUNT_ERROR = new RegExp(
  [
    String.raw`too many image(?:s|\s+(?:parts|inputs|blocks|attachments|files))\b`,
    String.raw`at most [\d,]+ image(?:s|\(s\))? (?:may|can)`,
    String.raw`images? per (?:request|prompt|message)`,
    String.raw`(?:number|count) of (?:input )?images\b[^.]{0,60}?\b(?:exceed|limit|max)`,
  ].join("|"),
  "i",
);
/** Digit groups first, so "3,000" is not read as 3. */
const COUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
const LIMIT_BEFORE_IMAGES = new RegExp(
  String.raw`(?:max(?:imum)?|limit|up to|at most|no more than)(?:\s+(?:is|of))?\s*[:=]?\s*${COUNT}\s+images?\b`,
  "i",
);
const LIMIT_PAIR = new RegExp(String.raw`\d[\d,]*\s*>\s*${COUNT}`);
const LIMIT_PHRASE = new RegExp(
  String.raw`(?:max(?:imum)?|limit|up to|at most|no more than)(?:\s+(?:is|of|allowed))*\s*[:=(]?\s*${COUNT}`,
  "i",
);

/** Whether a provider error rejects the request for carrying too many images. */
export function isImageCountError(errorMessage: string): boolean {
  return IMAGE_COUNT_ERROR.test(errorMessage);
}

/** The limit stated by an image-count error, e.g. 30 for "Too many images in request: 54 > 30". */
export function parseImageLimitError(errorMessage: string): number | undefined {
  const start = errorMessage.search(IMAGE_COUNT_ERROR);
  if (start < 0) return undefined;
  const detail = errorMessage.slice(start);
  const match =
    LIMIT_BEFORE_IMAGES.exec(errorMessage) ?? LIMIT_PAIR.exec(detail) ?? LIMIT_PHRASE.exec(detail);
  const limit = match ? Number(match[1].replaceAll(",", "")) : Number.NaN;
  return isLimit(limit) ? limit : undefined;
}

/**
 * Record the limit an image-count error states, or half of what the rejected
 * request carried when it states none. Returns the new limit when it is lower
 * than the one known for that model, otherwise `undefined`.
 */
export function learnRequestImageLimit(
  provider: string | undefined,
  modelId: string | undefined,
  errorMessage: string | undefined,
  sentImages = 0,
): number | undefined {
  if (!provider || !modelId || !errorMessage || !isImageCountError(errorMessage)) return undefined;
  const limit =
    parseImageLimitError(errorMessage) ?? (sentImages > 1 ? Math.floor(sentImages / 2) : undefined);
  if (limit === undefined) return undefined;
  const key = modelKey(provider, modelId);
  const known = learnedLimits().get(key);
  if (known !== undefined && known <= limit) return undefined;
  learnedLimits().set(key, limit);
  console.warn(
    `[leafcode-pi] ${provider}/${modelId} accepts at most ${limit} images per request; older images are omitted from now on`,
  );
  return limit;
}

/**
 * Session extension: cap images per request, learn tighter limits from
 * provider errors and resend the rejected request once it would fit.
 */
export function registerRequestImageCap(api: ExtensionAPI): void {
  let sentImages = 0;
  let retryPending = false;
  let autoRetries = 0;

  // Not `context`: a changed conversation there makes Pi fold mid-conversation
  // prompt/tool updates into a new leading system message, which invalidates the
  // whole cached prefix. Here system messages stay put and only image blocks
  // change; it also runs after every `context` handler, so it sees the final images.
  api.on("context_with_system", (event, ctx) => {
    const model = ctx.model;
    // Text-only models already get placeholders from pi-ai (or the provider wrapper).
    if (model && !model.input.includes("image")) {
      sentImages = 0;
      return undefined;
    }
    const limit = requestImageLimit(model);
    const messages = limit === undefined ? event.messages : capRequestImages(event.messages, limit);
    sentImages = countRequestImages(messages);
    return messages === event.messages ? undefined : { messages };
  });

  // A resend is decided by the run that failed; never carry it into another run.
  api.on("agent_start", () => {
    retryPending = false;
  });

  api.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return undefined;
    if (message.stopReason !== "error") {
      if (message.stopReason !== "aborted") autoRetries = 0;
      return undefined;
    }
    const learned = learnRequestImageLimit(
      message.provider,
      message.model,
      message.errorMessage,
      sentImages,
    );
    if (learned === undefined) return undefined;
    // A resend only helps when the new limit trims the rejected request.
    retryPending = learned < sentImages && autoRetries < MAX_AUTO_RETRIES;
    return { message: { ...message, errorMessage: `${message.errorMessage}\n${LIMIT_LEARNED_NOTE}` } };
  });

  api.on("agent_before_settle", (event) => {
    if (!retryPending) return undefined;
    retryPending = false;
    if (event.outcome !== "error") return undefined;
    const failed = event.context.contextEntries.findLast((entry) => entry.messages.length > 0);
    const message = failed?.messages.at(-1);
    if (!failed || message?.role !== "assistant" || message.stopReason !== "error") return undefined;
    autoRetries++;
    // Drop the rejected response from the model context so the conversation can
    // continue from the request that failed; the transcript still shows it.
    return {
      entries: [
        ...event.entries,
        { type: "context_edit", targetId: failed.sourceEntry.id, replacement: null },
      ],
      continue: true,
    };
  });
}
