export const TRANSLATION_PIPELINE_VERSION = 'reasoning-ja-2';

const LEADING_TEMPLATES = new Map([
  ['adding', '追加中'],
  ['analyzing', '分析中'],
  ['checking', '確認中'],
  ['cleaning', '整理中'],
  ['comparing', '比較中'],
  ['considering', '検討中'],
  ['creating', '作成中'],
  ['debugging', 'デバッグ中'],
  ['designing', '設計中'],
  ['diagnosing', '診断中'],
  ['documenting', '文書化中'],
  ['evaluating', '評価中'],
  ['exploring', '調査中'],
  ['fixing', '修正中'],
  ['identifying', '特定中'],
  ['implementing', '実装中'],
  ['inspecting', '確認中'],
  ['investigating', '調査中'],
  ['planning', '計画中'],
  ['preparing', '準備中'],
  ['reading', '確認中'],
  ['refactoring', 'リファクタリング中'],
  ['refining', '改善中'],
  ['removing', '削除中'],
  ['resolving', '解決中'],
  ['reviewing', 'レビュー中'],
  ['running', '実行中'],
  ['searching', '検索中'],
  ['summarizing', '要約中'],
  ['testing', 'テスト中'],
  ['tracing', '追跡中'],
  ['updating', '更新中'],
  ['validating', '検証中'],
  ['verifying', '検証中'],
]);

const PROTECTED_PATTERNS = [
  /`[^`\n]+`/g,
  /https?:\/\/[^\s)]+/g,
  /\b[A-Za-z0-9_./\\-]+\.(?:tsx?|jsx?|mjs|cjs|json|py|md|bat|cmd|ps1|ya?ml|toml|css|html|wasm|exe|dll)\b/g,
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])[^\s"'`]+/g,
  // CLI flags only. The leading boundary matters: without it a hyphenated
  // English word ("translation-service") had its tail protected as "-service",
  // so the engine received a broken token ("translation<x0> implementation")
  // and rendered "翻訳-service 実装" instead of "翻訳サービスの実装".
  /(?<![\w-])--?[A-Za-z][A-Za-z0-9-]*/g,
  /\b(?:LeafCode|OpenCode|WebUI|TypeScript|JavaScript|Next\.js|Node\.js|React|Python|Windows|GitHub|CTranslate2|Argos Translate)\b/g,
  /\b[A-Z][A-Z0-9]{1,9}\b/g,
  /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
  /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
  /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g,
];

const TERM_REPLACEMENTS = [
  [/設計ドキュメント/g, '設計書'],
  [/設計文書/g, '設計書'],
  [/メッセージ\s+スクロール/g, 'メッセージスクロール'],
  [/スクローラー/g, 'スクロール領域'],
  [/キャッシング/g, 'キャッシュ'],
  [/レンダーリング/g, 'レンダリング'],
  [/建築/g, 'アーキテクチャ'],
  [/\barchitecture\b/gi, 'アーキテクチャ'],
  [/\bcache\b/gi, 'キャッシュ'],
  [/\bendpoint\b/gi, 'エンドポイント'],
  [/\bfallback\b/gi, 'フォールバック'],
  [/\bhost\b/gi, 'ホスト'],
  [/\bimplementation\b/gi, '実装'],
  [/\bpayload\b/gi, 'ペイロード'],
  [/\breasoning\b/gi, '思考'],
  [/\bregression\b/gi, '回帰'],
  [/\brendering\b/gi, 'レンダリング'],
  [/\bretry\b/gi, '再試行'],
  [/\bscroller\b/gi, 'スクロール領域'],
  [/\bsession\b/gi, 'セッション'],
  [/\bstreaming\b/gi, 'ストリーミング'],
  [/\btimeout\b/gi, 'タイムアウト'],
  [/\bworkspace\b/gi, 'ワークスペース'],
];

const SUSPICIOUS_ENGLISH = new RegExp(
  `\\b(?:${[...LEADING_TEMPLATES.keys()].join('|')})\\b`,
  'i',
);

/**
 * Argos handles short progress fragments reliably, but long multi-paragraph
 * summaries often come back mostly unchanged. Keeping each engine input
 * below this size also prevents one unusually verbose reasoning part from
 * monopolising the stdio worker.
 */
export const REASONING_TRANSLATION_SEGMENT_MAX_CHARS = 800;

function hardSplitReasoningText(text, maxChars) {
  const result = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const whitespace = Math.max(
      remaining.lastIndexOf(' ', maxChars),
      remaining.lastIndexOf('\n', maxChars),
      remaining.lastIndexOf('\t', maxChars),
    );
    const cut = whitespace >= Math.floor(maxChars * 0.5) ? whitespace : maxChars;
    result.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

function splitReasoningParagraph(paragraph, maxChars) {
  const normalized = paragraph.replace(/\r?\n+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const sentences = normalized.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/g) ?? [normalized];
  const result = [];
  let current = '';
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) result.push(current);
    if (sentence.length <= maxChars) {
      current = sentence;
      continue;
    }
    const hard = hardSplitReasoningText(sentence, maxChars);
    result.push(...hard.slice(0, -1));
    current = hard.at(-1) ?? '';
  }
  if (current) result.push(current);
  return result;
}

/**
 * Split a verbose reasoning summary at paragraph/sentence boundaries. The
 * returned pieces are independently safe to send through the quality gate;
 * callers should reassemble successful translations with a blank line.
 */
export function splitReasoningTranslationText(
  source,
  maxChars = REASONING_TRANSLATION_SEGMENT_MAX_CHARS,
) {
  const text = typeof source === 'string' ? source.trim() : '';
  const limit = Number.isFinite(maxChars) && maxChars >= 1
    ? Math.floor(maxChars)
    : REASONING_TRANSLATION_SEGMENT_MAX_CHARS;
  if (!text || text.length <= limit) return text ? [text] : [];

  const paragraphs = text.split(/\r?\n(?:[ \t]*\r?\n)+/);
  const pieces = paragraphs.flatMap((paragraph) =>
    splitReasoningParagraph(paragraph, limit));
  return pieces.length > 0 ? pieces : [text];
}

function protectTechnicalText(text) {
  const tokens = [];
  const existing = [...text.matchAll(/<\s*x(\d+)\s*>/g)].map((m) => Number(m[1]));
  let nextId = existing.length > 0 ? Math.max(...existing) + 1 : 0;
  let protectedText = text;
  for (const pattern of PROTECTED_PATTERNS) {
    protectedText = protectedText.replace(pattern, (value) => {
      const token = `<x${nextId}>`;
      tokens.push({ id: nextId, token, value });
      nextId += 1;
      return token;
    });
  }
  return { text: protectedText, tokens };
}

function applyGlossary(text) {
  let result = text;
  for (const [pattern, replacement] of TERM_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function restoreTechnicalText(text, tokens) {
  let result = text;
  for (const token of tokens) {
    result = result.replace(
      new RegExp(`<\\s*x${token.id}\\s*>`, 'gi'),
      token.value,
    );
  }
  return result;
}

export function prepareReasoningTranslation(source, { retry = false } = {}) {
  const original = source.trim();
  let engineSource = original;
  let templateLabel = null;

  if (!retry && !original.includes('\n')) {
    const match = original.match(/^([A-Za-z]+ing)\s+(.+?)(?:[.!])?$/i);
    const label = match ? LEADING_TEMPLATES.get(match[1].toLowerCase()) : null;
    if (match && label) {
      engineSource = match[2];
      templateLabel = label;
    }
  } else if (retry) {
    engineSource = `Current task: ${original}`;
  }

  const protectedResult = protectTechnicalText(engineSource);
  return {
    original,
    // English the engine is asked to translate, before protection tokens are
    // substituted and without the retry scaffold: the leakage denominator.
    engineSource: retry ? original : engineSource,
    engineText: protectedResult.text,
    tokens: protectedResult.tokens,
    templateLabel,
  };
}

export function finalizeReasoningTranslation(prepared, translated) {
  let result = applyGlossary(translated.trim());
  result = restoreTechnicalText(result, prepared.tokens);
  result = result
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([、。！？：])/g, '$1')
    .trim();
  if (prepared.templateLabel) {
    result = `${prepared.templateLabel}：${result.replace(/[。.!]+$/, '')}`;
  }
  return result;
}

/**
 * Fraction of the engine input's English (measured in word characters) that a
 * translation may still contain. Real translations of technical summaries keep
 * identifiers and drop the prose, landing well under this; an untranslated or
 * half-translated echo lands at or near 1.
 */
const MAX_SOURCE_ENGLISH_KEPT = 0.5;

const LATIN_WORD_RE = /\b[A-Za-z][A-Za-z-]{2,}\b/g;

function latinWeight(text) {
  return (text.match(LATIN_WORD_RE) ?? []).join('').length;
}

export function assessReasoningTranslation(prepared, translated) {
  const result = translated.trim();
  if (!result || result.length > 16_000) return { acceptable: false, reason: 'empty-or-large' };
  if (result.localeCompare(prepared.original, undefined, { sensitivity: 'base' }) === 0) {
    return { acceptable: false, reason: 'unchanged' };
  }
  if (/<\s*x\d+\s*>/i.test(result)) return { acceptable: false, reason: 'placeholder' };

  let naturalText = result;
  for (const token of prepared.tokens) naturalText = naturalText.replaceAll(token.value, '');

  // Protected tokens must survive, but the engine sometimes normalizes
  // back-ticks away or inserts spaces around hyphens. Reject only when no
  // recognizable version of the token remains in the output.
  const tokenLost = prepared.tokens.some((token) => {
    if (result.includes(token.value)) return false;
    const bare = token.value.replace(/`/g, '').trim();
    if (bare && result.includes(bare)) return false;
    // The engine may translate protected words inside a token (e.g.
    // "--no-cache" → "--no-キャッシュ"). Accept if the token's leading
    // flag/file signature survives and no placeholder was left behind.
    const flagMatch = bare.match(/^(-+[A-Za-z0-9-]+)/);
    if (flagMatch) {
      const prefix = flagMatch[1];
      // Allow a partial prefix when the flag body was translated.
      if (result.includes(prefix)) return false;
      const parts = prefix.split('-');
      if (parts.length > 2 && result.includes(`${parts[0]}-${parts[1]}-`)) return false;
    }
    const fileMatch = bare.match(/\.[A-Za-z0-9]+$/);
    if (fileMatch && result.includes(fileMatch[0])) return false;
    // Compound suffixes the engine split and translated ("-principles" in
    // "first-principles" or "-state" in "blocked-state") are acceptable when a
    // natural translation of the suffix appears in the result. We check a small
    // Japanese/English glossary rather than requiring the literal suffix.
    const suffixTranslations = new Map([
      ['-state', '状態'],
      ['-principles', '原理'],
      ['-based', 'ベース'],
      ['-enabled', '有効'],
      ['-disabled', '無効'],
    ]);
    const suffixMatch = bare.match(/^(-[a-z]+)$/i);
    if (suffixMatch) {
      const suffix = suffixMatch[1].toLowerCase();
      const translatedSuffix = suffixTranslations.get(suffix);
      if (translatedSuffix && result.includes(translatedSuffix)) return false;
    }
    return true;
  });
  if (tokenLost) {
    return { acceptable: false, reason: 'protected-token-lost' };
  }
  const japaneseCount = naturalText.match(/[ぁ-ゖァ-ヺ一-龯々〆〄]/g)?.length ?? 0;
  if (japaneseCount === 0) return { acceptable: false, reason: 'no-japanese' };
  if (SUSPICIOUS_ENGLISH.test(naturalText)) {
    return { acceptable: false, reason: 'untranslated-progress-verb' };
  }

  // Command and tool names (`git log`, `todo`, `npm`) are correct to keep in
  // Latin, so scoring leakage by how much English *remains* rejects good
  // translations of identifier-dense summaries. Score how much of the English
  // the engine was asked to translate actually disappeared instead: output
  // that keeps most of its source English did not do the job.
  //
  // Exclude protected tokens from the source count: they are meant to survive
  // untranslated, so keeping them is not leakage.
  const protectedLatin = prepared.tokens
    .map((token) => latinWeight(token.value))
    .reduce((a, b) => a + b, 0);
  const sourceLatin = Math.max(
    0,
    latinWeight(prepared.engineSource ?? prepared.original) - protectedLatin,
  );
  const resultLatin = latinWeight(naturalText);
  if (sourceLatin > 0 && resultLatin / sourceLatin > MAX_SOURCE_ENGLISH_KEPT) {
    return { acceptable: false, reason: 'english-leakage' };
  }
  if (/\b([A-Za-z]{3,})\s+\1\s+\1\b/i.test(naturalText)) {
    return { acceptable: false, reason: 'repetition' };
  }
  if (/([ぁ-ゖァ-ヺ一-龯々〆〄]{2,8})(?:[、 ]*\1){2}/u.test(naturalText)) {
    return { acceptable: false, reason: 'repetition' };
  }
  if (/[!?！？。]{3,}/u.test(naturalText)) {
    return { acceptable: false, reason: 'punctuation-repetition' };
  }
  return { acceptable: true, reason: null };
}

/**
 * Upper bound on a translation the AI review pass may skip. Anything longer
 * carries real translation risk even behind a fixed label.
 */
export const TRIVIAL_REVIEW_MAX_CHARS = 80;

/**
 * True when the paid AI review pass can skip this cache entry. A leading
 * progress verb that matched LEADING_TEMPLATES is rendered from a fixed
 * Japanese template, so a short result is already determined locally and
 * sending it to a model only burns tokens.
 * @param {unknown} text source English reasoning summary
 * @param {unknown} translation cached Japanese translation
 */
export function isTrivialReviewCandidate(text, translation) {
  const source = typeof text === 'string' ? text.trim() : '';
  const result = typeof translation === 'string' ? translation.trim() : '';
  if (!source || !result) return false;
  if (result.length > TRIVIAL_REVIEW_MAX_CHARS) return false;
  return prepareReasoningTranslation(source).templateLabel !== null;
}
