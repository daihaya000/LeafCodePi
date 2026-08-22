import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessReasoningTranslation,
  finalizeReasoningTranslation,
  isTrivialReviewCandidate,
  prepareReasoningTranslation,
  splitReasoningTranslationText,
} from './reasoning-translation-quality.js';

test('leading progress verbs use a stable Japanese template', () => {
  const prepared = prepareReasoningTranslation('Summarizing final design document and architecture');
  assert.equal(prepared.engineText, 'final design document and architecture');
  assert.equal(
    finalizeReasoningTranslation(prepared, '最終的な設計文書および建築'),
    '要約中：最終的な設計書およびアーキテクチャ',
  );
});

test('technical identifiers survive translation unchanged', () => {
  const prepared = prepareReasoningTranslation(
    'Checking `scrollTop`, src/TaskView.tsx, and --no-cache behavior',
  );
  assert.match(prepared.engineText, /<x\d+>/);
  const placeholders = prepared.tokens.map((token) => token.token).join('、');
  const result = finalizeReasoningTranslation(prepared, `${placeholders} の動作`);
  assert.match(result, /`scrollTop`/);
  assert.match(result, /src\/TaskView\.tsx/);
  assert.match(result, /--no-cache/);
  assert.equal(assessReasoningTranslation(prepared, result).acceptable, true);
});

test('token IDs avoid collision with literal <xN> already in source', () => {
  // Regression: collision avoidance only checked <x0>, so a source containing
  // <x5> with 6+ protected tokens produced a duplicate <x5> placeholder that
  // restoreTechnicalText then replaced with the wrong value.
  const source = 'Checking <x5> and `a`, `b`, `c`, `d`, `e`, `f`';
  const prepared = prepareReasoningTranslation(source);
  const ids = prepared.tokens.map((t) => t.id);
  assert.ok(ids.length >= 6, `expected >= 6 tokens, got ${ids.length}`);
  assert.ok(!ids.includes(5), `token ID 5 collides with source <x5>: ${JSON.stringify(ids)}`);
  assert.ok(ids.every((id) => id >= 6), `expected all IDs >= 6, got: ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, 'token IDs must be unique');
});

test('hyphenated words reach the engine whole, real flags stay protected', () => {
  // Regression: "-service" matched the CLI-flag pattern, so the engine received
  // "translation<x0> implementation" and produced "翻訳-service 実装".
  const prose = prepareReasoningTranslation('Reviewing translation-service implementation');
  assert.equal(prose.engineText, 'translation-service implementation');
  assert.deepEqual(prose.tokens, []);

  const flags = prepareReasoningTranslation('Running build with -v and --no-cache');
  assert.deepEqual(flags.tokens.map((token) => token.value), ['-v', '--no-cache']);

  // A hyphenated file name is still protected as a whole by the path pattern.
  const file = prepareReasoningTranslation('Reading translation-service.js again');
  assert.deepEqual(file.tokens.map((token) => token.value), ['translation-service.js']);
});

test('translations that keep command names are not treated as leakage', () => {
  // Regression: `git`, `log` and `todo` are correct to keep in Latin, but the
  // gate counted them as untranslated English and showed the raw English
  // reasoning summary instead.
  const source = 'Planning git log verification and todo completion';
  const prepared = prepareReasoningTranslation(source);
  assert.equal(
    assessReasoningTranslation(prepared, '計画中：git log 検証と Todo 完了').acceptable,
    true,
  );

  const retried = prepareReasoningTranslation(source, { retry: true });
  assert.equal(
    assessReasoningTranslation(retried, '現在のタスク: git log の検証と todo 完了を計画する')
      .acceptable,
    true,
  );
});

test('quality gate rejects English kept behind the Japanese label', () => {
  // The template label supplies Japanese characters on its own, so an engine
  // that echoed its input must still be caught by the leakage score.
  const prepared = prepareReasoningTranslation('Planning next steps');
  assert.deepEqual(assessReasoningTranslation(prepared, '計画中：next steps'), {
    acceptable: false,
    reason: 'english-leakage',
  });

  const dense = prepareReasoningTranslation(
    'Planning git log verification and todo completion',
  );
  assert.equal(
    assessReasoningTranslation(dense, '計画中：git log verification and todo completion')
      .acceptable,
    false,
  );
  assert.equal(
    assessReasoningTranslation(dense, '計画中：verification and todo 完了').acceptable,
    false,
  );
});

test('quality gate rejects untranslated or damaged output', () => {
  const prepared = prepareReasoningTranslation('Reviewing cache implementation');
  assert.equal(
    assessReasoningTranslation(prepared, 'Reviewing cache implementation').acceptable,
    false,
  );
  assert.equal(
    assessReasoningTranslation(prepared, '実装を reviewing').acceptable,
    false,
  );
  assert.equal(
    assessReasoningTranslation(prepared, '確認確認確認').acceptable,
    false,
  );
});

test('long multi-paragraph summaries split at readable boundaries', () => {
  const source = [
    'Diff stats look clean. The untracked files are listed here.',
    'Now I need to decide on the commit message. The feature is complete.',
    'Before commit, check git status and commit the verified changes.',
  ].join('\n\n');

  const pieces = splitReasoningTranslationText(source, 80);

  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces, [
    'Diff stats look clean. The untracked files are listed here.',
    'Now I need to decide on the commit message. The feature is complete.',
    'Before commit, check git status and commit the verified changes.',
  ]);
  assert.ok(pieces.every((piece) => piece.length <= 80));
});

test('short template lines are trivial for the paid review, other text is not', () => {
  // Rendered from a fixed Japanese label, so a model cannot improve it.
  assert.equal(isTrivialReviewCandidate('Checking the diff', '確認中：差分'), true);

  // No leading progress verb: the whole sentence came from the engine.
  assert.equal(
    isTrivialReviewCandidate(
      'The diff introduces a regression in the cache layer.',
      'この差分はキャッシュ層に回帰を持ち込みます。',
    ),
    false,
  );

  // Labelled but long: the text after the label still carries real risk.
  assert.equal(
    isTrivialReviewCandidate(`Checking ${'the diff and its callers '.repeat(6)}`, `確認中：${'差分と呼び出し元'.repeat(12)}`),
    false,
  );

  assert.equal(isTrivialReviewCandidate('', '確認中：差分'), false);
  assert.equal(isTrivialReviewCandidate('Checking the diff', '   '), false);
  assert.equal(isTrivialReviewCandidate(null, undefined), false);
});
