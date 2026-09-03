import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createTranslationService } from './translation-service.js';
import { TRANSLATION_PIPELINE_VERSION } from './reasoning-translation-quality.js';

async function cleanupTempDir(path, services = []) {
  for (const service of services) {
    service?.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows may keep translation handles briefly */
  }
}

test('translation status reports an installed runtime before lazy startup', () => {
  const dataDir = join(tmpdir(), `leafcode-translation-status-${process.pid}`);
  const translationDir = join(dataDir, 'translation');
  const modelDir = join(translationDir, 'packages', 'en_ja', 'model');
  const venvBin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const pythonName = process.platform === 'win32' ? 'python.exe' : 'python';
  const pythonPath = join(translationDir, 'venv', venvBin, pythonName);
  const originalPython = process.env.LEAFCODE_TRANSLATION_PYTHON;
  delete process.env.LEAFCODE_TRANSLATION_PYTHON;
  rmSync(dataDir, { recursive: true, force: true });
  try {
    const service = createTranslationService({ repoRoot: process.cwd(), dataDir });
    assert.equal(service.status().installed, false);

    mkdirSync(modelDir, { recursive: true });
    mkdirSync(join(translationDir, 'venv', venvBin), { recursive: true });
    writeFileSync(pythonPath, '');
    writeFileSync(join(translationDir, 'packages', 'en_ja', 'metadata.json'), '{}');
    writeFileSync(join(modelDir, 'model.bin'), '');

    assert.equal(existsSync(pythonPath), true);
    assert.equal(service.status().state, 'stopped');
    assert.equal(service.status().installed, true);
    service.stop();
  } finally {
    if (originalPython === undefined) delete process.env.LEAFCODE_TRANSLATION_PYTHON;
    else process.env.LEAFCODE_TRANSLATION_PYTHON = originalPython;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function seededCacheKey(text, modelVersion) {
  return createHash('sha256')
    .update(`en\0ja\0${TRANSLATION_PIPELINE_VERSION}\0${modelVersion}\0${text}`, 'utf8')
    .digest('hex');
}

test('applyReviewResults overwrites poor translations and marks entries reviewed', () => {
  const dataDir = join(tmpdir(), `leafcode-translation-review-${process.pid}`);
  const translationDir = join(dataDir, 'translation');
  const poorText = 'A poorly translated reasoning line';
  const goodText = 'A well translated reasoning line';
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(translationDir, { recursive: true });
  writeFileSync(join(translationDir, 'cache.json'), JSON.stringify({
    version: 2,
    entries: {
      [seededCacheKey(poorText, 'unknown')]: {
        source: 'en',
        target: 'ja',
        pipelineVersion: TRANSLATION_PIPELINE_VERSION,
        modelVersion: 'unknown',
        text: poorText,
        translation: '直訳されたまずい訳',
        updatedAt: Date.now(),
      },
      [seededCacheKey(goodText, 'unknown')]: {
        source: 'en',
        target: 'ja',
        pipelineVersion: TRANSLATION_PIPELINE_VERSION,
        modelVersion: 'unknown',
        text: goodText,
        translation: '十分に良い訳',
        updatedAt: Date.now(),
      },
    },
  }));
  try {
    const service = createTranslationService({ repoRoot: process.cwd(), dataDir });
    // Both seeded entries are pending review.
    const pending = service.unreviewedEntries(500);
    assert.equal(pending.length, 2);

    const updated = service.applyReviewResults([
      { text: poorText, quality: 'poor', corrected: 'AIが見直した訳' },
      { text: goodText, quality: 'good' },
    ], 'review-model-x');
    assert.equal(updated, 2);
    assert.equal(service.status().unreviewedEntries, 0);

    const payload = JSON.parse(readFileSync(join(translationDir, 'cache.json'), 'utf8'));
    const poorEntry = Object.values(payload.entries).find((e) => e.text === poorText);
    const goodEntry = Object.values(payload.entries).find((e) => e.text === goodText);
    assert.equal(poorEntry.translation, 'AIが見直した訳');
    assert.equal(poorEntry.reviewed, true);
    assert.equal(poorEntry.reviewModel, 'review-model-x');
    assert.equal(goodEntry.translation, '十分に良い訳');
    assert.equal(goodEntry.reviewed, true);
    service.stop();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('applyReviewResults rejects corrections that fail the quality gate', () => {
  const dataDir = join(tmpdir(), `leafcode-translation-review-gate-${process.pid}`);
  const translationDir = join(dataDir, 'translation');
  const text = 'Reviewing the cache invalidation path';
  const original = 'レビュー中：キャッシュ無効化の経路';
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(translationDir, { recursive: true });
  writeFileSync(join(translationDir, 'cache.json'), JSON.stringify({
    version: 2,
    entries: {
      [seededCacheKey(text, 'unknown')]: {
        source: 'en',
        target: 'ja',
        pipelineVersion: TRANSLATION_PIPELINE_VERSION,
        modelVersion: 'unknown',
        text,
        translation: original,
        updatedAt: Date.now(),
      },
    },
  }));
  try {
    const service = createTranslationService({ repoRoot: process.cwd(), dataDir });
    // A model that echoes the English back must not overwrite a usable
    // translation, but the entry is still consumed so the run does not repeat.
    const updated = service.applyReviewResults([
      { text, quality: 'poor', corrected: 'Reviewing the cache invalidation path' },
    ], 'review-model-x');
    assert.equal(updated, 1);
    assert.equal(service.status().unreviewedEntries, 0);

    const payload = JSON.parse(readFileSync(join(translationDir, 'cache.json'), 'utf8'));
    const entry = Object.values(payload.entries).find((e) => e.text === text);
    assert.equal(entry.translation, original);
    assert.equal(entry.reviewed, true);
    assert.equal(entry.reviewModel, 'review-model-x');
    service.stop();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('skipTrivialReviews marks fixed-template lines reviewed without a model call', () => {
  const dataDir = join(tmpdir(), `leafcode-translation-trivial-${process.pid}`);
  const translationDir = join(dataDir, 'translation');
  const templateText = 'Checking the diff';
  const proseText = 'The diff introduces a regression in the cache layer.';
  const seed = (text, translation) => ({
    source: 'en',
    target: 'ja',
    pipelineVersion: TRANSLATION_PIPELINE_VERSION,
    modelVersion: 'unknown',
    text,
    translation,
    updatedAt: Date.now(),
  });
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(translationDir, { recursive: true });
  writeFileSync(join(translationDir, 'cache.json'), JSON.stringify({
    version: 2,
    entries: {
      [seededCacheKey(templateText, 'unknown')]: seed(templateText, '確認中：差分'),
      [seededCacheKey(proseText, 'unknown')]: seed(
        proseText,
        'この差分はキャッシュ層に回帰を持ち込みます。',
      ),
    },
  }));
  try {
    const service = createTranslationService({ repoRoot: process.cwd(), dataDir });
    assert.equal(service.status().unreviewedEntries, 2);

    assert.equal(service.skipTrivialReviews(), 1);
    assert.equal(service.status().unreviewedEntries, 1);
    // Only the prose entry is worth spending review tokens on.
    assert.deepEqual(
      service.unreviewedEntries(500).map((entry) => entry.text),
      [proseText],
    );
    // Idempotent: a second pass finds nothing new to skip.
    assert.equal(service.skipTrivialReviews(), 0);

    const payload = JSON.parse(readFileSync(join(translationDir, 'cache.json'), 'utf8'));
    const skipped = Object.values(payload.entries).find((e) => e.text === templateText);
    assert.equal(skipped.reviewed, true);
    assert.equal(skipped.reviewModel, 'local-heuristic');
    assert.equal(skipped.translation, '確認中：差分');
    service.stop();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('translation cache is reused by a new service instance', async () => {
  const dataDir = join(tmpdir(), `leafcode-translation-cache-${process.pid}`);
  const translationDir = join(dataDir, 'translation');
  const text = 'Persist this reasoning translation across host restarts';
  const translation = 'この思考の翻訳をホスト再起動後も保持';
  const key = createHash('sha256')
    .update(`en\0ja\0${TRANSLATION_PIPELINE_VERSION}\0unknown\0${text}`, 'utf8')
    .digest('hex');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(translationDir, { recursive: true });
  writeFileSync(join(translationDir, 'cache.json'), JSON.stringify({
    version: 2,
    entries: {
      [key]: {
        source: 'en',
        target: 'ja',
        pipelineVersion: TRANSLATION_PIPELINE_VERSION,
        modelVersion: 'unknown',
        text,
        translation,
        updatedAt: Date.now(),
      },
    },
  }));
  try {
    const first = createTranslationService({ repoRoot: process.cwd(), dataDir });
    const firstResult = await first.translate([text]);
    assert.equal(firstResult.v, 1);
    assert.equal(typeof firstResult.id, 'string');
    assert.equal(firstResult.ok, true);
    assert.deepEqual(firstResult.translations, [translation]);
    assert.equal(first.status().cacheEntries, 1);
    assert.equal(first.status().state, 'stopped');
    first.stop();

    const second = createTranslationService({ repoRoot: process.cwd(), dataDir });
    assert.deepEqual((await second.translate([text])).translations, [translation]);
    assert.equal(second.status().state, 'stopped');
    second.stop();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('translation cache from an older pipeline version is ignored', () => {
  const dataDir = join(tmpdir(), `leafcode-translation-stale-cache-${process.pid}`);
  const translationDir = join(dataDir, 'translation');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(translationDir, { recursive: true });
  writeFileSync(join(translationDir, 'cache.json'), JSON.stringify({
    version: 1,
    entries: {
      stale: {
        source: 'en',
        target: 'ja',
        text: 'stale source',
        translation: '古い訳',
        updatedAt: Date.now(),
      },
    },
  }));
  try {
    const service = createTranslationService({ repoRoot: process.cwd(), dataDir });
    assert.equal(service.status().cacheEntries, 0);
    assert.equal(service.status().pipelineVersion, TRANSLATION_PIPELINE_VERSION);
    service.stop();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('user correction overrides translation across service instances', async () => {
  const dataDir = join(tmpdir(), `leafcode-translation-override-${process.pid}`);
  const text = 'Reviewing exact override behavior';
  const correction = '完全一致する修正訳を確認中';
  rmSync(dataDir, { recursive: true, force: true });
  try {
    const first = createTranslationService({ repoRoot: process.cwd(), dataDir });
    assert.deepEqual(first.setOverride(text, correction), { text, translation: correction });
    const firstResult = await first.translate([text]);
    assert.deepEqual(firstResult.translations, [correction]);
    assert.deepEqual(firstResult.overridden, [true]);
    assert.equal(first.status().state, 'stopped');
    first.stop();

    const second = createTranslationService({ repoRoot: process.cwd(), dataDir });
    const secondResult = await second.translate([text]);
    assert.deepEqual(secondResult.translations, [correction]);
    assert.deepEqual(secondResult.overridden, [true]);
    assert.equal(second.status().overrideEntries, 1);
    assert.equal(second.status().state, 'stopped');
    const saved = JSON.parse(readFileSync(join(dataDir, 'translation', 'overrides.json'), 'utf8'));
    assert.equal(saved.version, 1);
    second.stop();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function writeFakeService(repoRoot, { improveRetry }) {
  const translationDir = join(repoRoot, 'translation');
  mkdirSync(translationDir, { recursive: true });
  writeFileSync(join(translationDir, 'translation_service.py'), `
const readline = require('node:readline');
process.stdout.write(JSON.stringify({ v: 1, type: 'ready', ok: true }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  const translations = request.texts.map((text) =>
    ${improveRetry ? "text.startsWith('Current task:') ? '再試行で改善された訳' : text" : 'text'}
  );
  process.stdout.write(JSON.stringify({ v: 1, id: request.id, ok: true, translations }) + '\\n');
});
`, 'utf8');
}

function writeSegmentingFakeService(repoRoot) {
  const translationDir = join(repoRoot, 'translation');
  mkdirSync(translationDir, { recursive: true });
  writeFileSync(join(translationDir, 'translation_service.py'), `
const readline = require('node:readline');
process.stdout.write(JSON.stringify({ v: 1, type: 'ready', ok: true }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  const translations = request.texts.map(() => '日本語訳');
  process.stdout.write(JSON.stringify({ v: 1, id: request.id, ok: true, translations }) + '\\n');
});
`, 'utf8');
}

test('quality failure retries once and persists an improved result', async () => {
  const root = join(tmpdir(), `leafcode-translation-retry-${process.pid}`);
  const repoRoot = join(root, 'repo');
  const dataDir = join(root, 'data');
  const originalPython = process.env.LEAFCODE_TRANSLATION_PYTHON;
  process.env.LEAFCODE_TRANSLATION_PYTHON = process.execPath;
  rmSync(root, { recursive: true, force: true });
  writeFakeService(repoRoot, { improveRetry: true });
  let first;
  let second;
  try {
    first = createTranslationService({ repoRoot, dataDir });
    const result = await first.translate(['Untranslated progress fragment']);
    assert.deepEqual(result.translations, ['再試行で改善された訳']);
    assert.deepEqual(result.fallbacks, [false]);
    assert.equal(first.status().cacheEntries, 1);
    first.stop();

    second = createTranslationService({ repoRoot, dataDir });
    assert.deepEqual(
      (await second.translate(['Untranslated progress fragment'])).translations,
      ['再試行で改善された訳'],
    );
    assert.equal(second.status().state, 'stopped');
  } finally {
    first?.stop();
    second?.stop();
    if (originalPython === undefined) delete process.env.LEAFCODE_TRANSLATION_PYTHON;
    else process.env.LEAFCODE_TRANSLATION_PYTHON = originalPython;
    await cleanupTempDir(root, [first, second]);
  }
});

test('long multi-paragraph summaries are translated per segment and reassembled', async () => {
  const root = join(tmpdir(), `leafcode-translation-long-${process.pid}`);
  const repoRoot = join(root, 'repo');
  const dataDir = join(root, 'data');
  const originalPython = process.env.LEAFCODE_TRANSLATION_PYTHON;
  process.env.LEAFCODE_TRANSLATION_PYTHON = process.execPath;
  rmSync(root, { recursive: true, force: true });
  writeSegmentingFakeService(repoRoot);
  let service;
  try {
    service = createTranslationService({ repoRoot, dataDir });
    const source = [
      'Diff stats look clean. The untracked files are listed here. '.repeat(6),
      'Now I need to decide on the commit message. The feature is complete. '.repeat(6),
      'Before commit, check git status and commit the verified changes. '.repeat(6),
    ].join('\n\n');
    const result = await service.translate([source]);
    assert.deepEqual(result.translations, ['日本語訳\n\n日本語訳\n\n日本語訳']);
    assert.deepEqual(result.fallbacks, [false]);
    assert.equal(service.status().cacheEntries, 1);
  } finally {
    if (originalPython === undefined) delete process.env.LEAFCODE_TRANSLATION_PYTHON;
    else process.env.LEAFCODE_TRANSLATION_PYTHON = originalPython;
    await cleanupTempDir(root, [service]);
  }
});

test('unacceptable retry falls back to the source without caching it', async () => {
  const root = join(tmpdir(), `leafcode-translation-fallback-${process.pid}`);
  const repoRoot = join(root, 'repo');
  const dataDir = join(root, 'data');
  const originalPython = process.env.LEAFCODE_TRANSLATION_PYTHON;
  process.env.LEAFCODE_TRANSLATION_PYTHON = process.execPath;
  rmSync(root, { recursive: true, force: true });
  writeFakeService(repoRoot, { improveRetry: false });
  let service;
  try {
    service = createTranslationService({ repoRoot, dataDir });
    const result = await service.translate(['Still untranslated']);
    assert.deepEqual(result.translations, ['Still untranslated']);
    assert.deepEqual(result.fallbacks, [true]);
    assert.equal(service.status().cacheEntries, 0);
  } finally {
    if (originalPython === undefined) delete process.env.LEAFCODE_TRANSLATION_PYTHON;
    else process.env.LEAFCODE_TRANSLATION_PYTHON = originalPython;
    await cleanupTempDir(root, [service]);
  }
});

test('install reports idle state and rejects a missing installer', () => {
  const dataDir = join(tmpdir(), `leafcode-translation-install-${process.pid}`);
  const repoRoot = join(tmpdir(), `leafcode-translation-install-repo-${process.pid}`);
  rmSync(dataDir, { recursive: true, force: true });
  try {
    const service = createTranslationService({ repoRoot, dataDir });
    assert.equal(service.status().installState, 'idle');
    assert.throws(() => service.install(), /installer is missing/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
