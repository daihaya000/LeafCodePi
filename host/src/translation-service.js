import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { writeSecretFile } from './secure-file.js';
import {
  TRANSLATION_PIPELINE_VERSION,
  assessReasoningTranslation,
  finalizeReasoningTranslation,
  isTrivialReviewCandidate,
  prepareReasoningTranslation,
  splitReasoningTranslationText,
} from './reasoning-translation-quality.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ENGINE_ITEMS = 16;
const MAX_ENGINE_CHARS = 16_000;
/** reviewModel value recorded when the local heuristic skipped the AI pass. */
const TRIVIAL_REVIEW_MODEL = 'local-heuristic';
const SOURCE_CODE = 'en';
const TARGET_CODE = 'ja';
const CACHE_VERSION = 2;
const CACHE_MAX_ENTRIES = 1_000;
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const OVERRIDE_VERSION = 1;
const OVERRIDE_MAX_ENTRIES = 1_000;
const OVERRIDE_MAX_BYTES = 4 * 1024 * 1024;

function executable(dataDir) {
  const configured = process.env.LEAFCODE_TRANSLATION_PYTHON?.trim();
  if (configured) return { file: configured, args: [] };
  const managed = process.platform === 'win32'
    ? join(dataDir, 'translation', 'venv', 'Scripts', 'python.exe')
    : join(dataDir, 'translation', 'venv', 'bin', 'python');
  if (existsSync(managed)) return { file: managed, args: [] };
  if (process.platform === 'win32') return { file: 'py', args: ['-3'] };
  return { file: 'python3', args: [] };
}

export function createTranslationService({ repoRoot, dataDir, log = () => {} }) {
  let child = null;
  let reader = null;
  let pending = new Map();
  const inFlight = new Map();
  let state = 'stopped';
  let lastError = null;

  const script = join(repoRoot, 'translation', 'translation_service.py');
  const packagesDir = join(dataDir, 'translation', 'packages');
  const cacheFile = join(dataDir, 'translation', 'cache.json');
  const overridesFile = join(dataDir, 'translation', 'overrides.json');
  const cache = new Map();
  const overrides = new Map();
  let cacheLoaded = false;
  let overridesLoaded = false;
  let cachedModelVersion = null;
  let installProc = null;
  let installError = null;
  let installStderr = '';
  /** Serialize stdin writes — parallel batches must not interleave JSON lines. */
  let stdinQueue = Promise.resolve();

  function enqueueStdinWrite(line) {
    const task = stdinQueue.then(
      () =>
        new Promise((resolve, reject) => {
          if (!child?.stdin) {
            reject(new Error('translation stdin unavailable'));
            return;
          }
          const ok = child.stdin.write(line, 'utf8', (err) => {
            if (err) reject(err);
            else resolve(undefined);
          });
          if (!ok) {
            child.stdin.once('drain', resolve);
            child.stdin.once('error', reject);
          }
        }),
    );
    stdinQueue = task.catch(() => undefined);
    return task;
  }

  function modelVersion() {
    if (cachedModelVersion !== null && cachedModelVersion !== 'unknown') return cachedModelVersion;
    try {
      const metadata = JSON.parse(readFileSync(join(packagesDir, 'en_ja', 'metadata.json'), 'utf8'));
      const packageVersion = typeof metadata?.package_version === 'string'
        ? metadata.package_version
        : 'unknown';
      const argosVersion = typeof metadata?.argos_version === 'string'
        ? metadata.argos_version
        : 'unknown';
      cachedModelVersion = `${packageVersion}:${argosVersion}`;
    } catch {
      cachedModelVersion = 'unknown';
    }
    return cachedModelVersion;
  }

  function cacheKey(text) {
    return createHash('sha256')
      .update(
        `${SOURCE_CODE}\0${TARGET_CODE}\0${TRANSLATION_PIPELINE_VERSION}\0${modelVersion()}\0${text}`,
        'utf8',
      )
      .digest('hex');
  }

  function overrideKey(text) {
    return createHash('sha256')
      .update(`${SOURCE_CODE}\0${TARGET_CODE}\0${text}`, 'utf8')
      .digest('hex');
  }

  function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const payload = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (payload?.version !== CACHE_VERSION || !payload.entries || typeof payload.entries !== 'object') {
        return;
      }
      for (const [key, entry] of Object.entries(payload.entries)) {
        if (
          typeof key !== 'string' ||
          typeof entry?.source !== 'string' ||
          typeof entry?.target !== 'string' ||
          typeof entry?.text !== 'string' ||
          typeof entry?.translation !== 'string' ||
          entry.source !== SOURCE_CODE ||
          entry.target !== TARGET_CODE ||
          entry.pipelineVersion !== TRANSLATION_PIPELINE_VERSION ||
          entry.modelVersion !== modelVersion() ||
          !entry.text.trim() ||
          entry.text.length > 16_000 ||
          entry.translation.length > 16_000 ||
          cacheKey(entry.text) !== key
        ) {
          continue;
        }
        cache.set(key, {
          source: SOURCE_CODE,
          target: TARGET_CODE,
          pipelineVersion: TRANSLATION_PIPELINE_VERSION,
          modelVersion: modelVersion(),
          text: entry.text,
          translation: entry.translation,
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
          reviewed: entry.reviewed === true,
          reviewModel: typeof entry.reviewModel === 'string' ? entry.reviewModel : null,
          reviewedAt: Number.isFinite(entry.reviewedAt) ? entry.reviewedAt : 0,
        });
      }
    } catch {
      // A corrupt cache is disposable; the next successful translation rebuilds it.
    }
  }

  function loadOverrides() {
    if (overridesLoaded) return;
    overridesLoaded = true;
    try {
      const payload = JSON.parse(readFileSync(overridesFile, 'utf8'));
      if (payload?.version !== OVERRIDE_VERSION || !payload.entries || typeof payload.entries !== 'object') {
        return;
      }
      for (const [key, entry] of Object.entries(payload.entries)) {
        if (
          typeof key !== 'string' ||
          typeof entry?.source !== 'string' ||
          typeof entry?.target !== 'string' ||
          typeof entry?.text !== 'string' ||
          typeof entry?.translation !== 'string' ||
          entry.source !== SOURCE_CODE ||
          entry.target !== TARGET_CODE ||
          !entry.text.trim() ||
          !entry.translation.trim() ||
          entry.text.length > 16_000 ||
          entry.translation.length > 16_000 ||
          overrideKey(entry.text) !== key
        ) {
          continue;
        }
        overrides.set(key, {
          source: SOURCE_CODE,
          target: TARGET_CODE,
          text: entry.text,
          translation: entry.translation,
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        });
      }
    } catch {
      // A corrupt override file is ignored rather than blocking translation.
    }
  }

  function saveCache() {
    const entries = [...cache.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    while (entries.length > CACHE_MAX_ENTRIES) {
      const [key] = entries.pop();
      cache.delete(key);
    }

    const makePayload = () => JSON.stringify({
      version: CACHE_VERSION,
      entries: Object.fromEntries(entries),
    });
    let serialized = makePayload();
    while (Buffer.byteLength(serialized, 'utf8') > CACHE_MAX_BYTES && entries.length > 0) {
      const [key] = entries.pop();
      cache.delete(key);
      serialized = makePayload();
    }
    try {
      writeSecretFile(cacheFile, serialized, {
        onError: (message) => log(`[translation] ${message}`),
      });
    } catch (error) {
      log(`[translation] cache write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function saveOverrides() {
    const entries = [...overrides.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    while (entries.length > OVERRIDE_MAX_ENTRIES) {
      const [key] = entries.pop();
      overrides.delete(key);
    }
    const makePayload = () => JSON.stringify({
      version: OVERRIDE_VERSION,
      entries: Object.fromEntries(entries),
    });
    let serialized = makePayload();
    while (Buffer.byteLength(serialized, 'utf8') > OVERRIDE_MAX_BYTES && entries.length > 0) {
      const [key] = entries.pop();
      overrides.delete(key);
      serialized = makePayload();
    }
    writeSecretFile(overridesFile, serialized, {
      onError: (message) => log(`[translation] ${message}`),
    });
  }

  function getCached(text) {
    loadCache();
    const entry = cache.get(cacheKey(text));
    return entry?.text === text ? entry.translation : null;
  }

  function getOverride(text) {
    loadOverrides();
    const entry = overrides.get(overrideKey(text));
    return entry?.text === text ? entry.translation : null;
  }

  function remember(text, translation, { save = true } = {}) {
    cache.set(cacheKey(text), {
      source: SOURCE_CODE,
      target: TARGET_CODE,
      pipelineVersion: TRANSLATION_PIPELINE_VERSION,
      modelVersion: modelVersion(),
      text,
      translation,
      updatedAt: Date.now(),
      reviewed: false,
      reviewModel: null,
      reviewedAt: 0,
    });
    if (save) saveCache();
  }

  function setOverride(text, translation) {
    const sourceText = typeof text === 'string' ? text : '';
    const corrected = typeof translation === 'string' ? translation.trim() : '';
    if (!sourceText.trim() || !corrected) throw new Error('text and translation are required');
    if (sourceText.length > 16_000 || corrected.length > 16_000) {
      throw new Error('translation override is too large');
    }
    loadOverrides();
    overrides.set(overrideKey(sourceText), {
      source: SOURCE_CODE,
      target: TARGET_CODE,
      text: sourceText,
      translation: corrected,
      updatedAt: Date.now(),
    });
    saveOverrides();
    return { text: sourceText, translation: corrected };
  }

  /**
   * Translation-cache entries not yet reviewed by the AI quality batch, most
   * recently updated first. The BFF sends these to a configured model for
   * review. User overrides are never part of this list.
   * @param {number} [limit]
   */
  function unreviewedEntries(limit = 100) {
    loadCache();
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    const items = [...cache.values()].filter((entry) => !entry.reviewed);
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items.slice(0, max).map((entry) => ({
      text: entry.text,
      translation: entry.translation,
    }));
  }

  /**
   * Mark entries the paid AI review pass does not need to see as reviewed
   * locally, so they neither reach the model nor keep the unreviewed counter
   * (and therefore the periodic run) alive. Returns the number marked.
   */
  function skipTrivialReviews() {
    loadCache();
    let skipped = 0;
    for (const entry of cache.values()) {
      if (entry.reviewed) continue;
      if (!isTrivialReviewCandidate(entry.text, entry.translation)) continue;
      entry.reviewed = true;
      entry.reviewModel = TRIVIAL_REVIEW_MODEL;
      entry.reviewedAt = Date.now();
      skipped += 1;
    }
    if (skipped > 0) saveCache();
    return skipped;
  }

  /**
   * Apply AI review outcomes to the cache. Entries whose quality is not
   * "good" and that carry a non-empty corrected translation are overwritten
   * with the corrected text; every matched entry is marked reviewed with the
   * review model key. Unknown texts are skipped. Returns the update count.
   *
   * A correction is a model-authored string that the WebUI displays and this
   * host persists, so it passes the same quality gate as engine output.
   * Corrections that fail it leave the existing translation in place and are
   * still marked reviewed, so a model that keeps proposing bad Japanese cannot
   * poison the cache or keep the periodic run burning tokens on one entry.
   * @param {{ text: string, quality: string, corrected?: string }[]} results
   * @param {string} model
   */
  function applyReviewResults(results, model = 'unknown') {
    if (!Array.isArray(results)) return 0;
    loadCache();
    let updated = 0;
    for (const result of results) {
      const text = typeof result?.text === 'string' ? result.text : '';
      if (!text.trim()) continue;
      const entry = cache.get(cacheKey(text));
      if (!entry || entry.text !== text) continue;

      const corrected =
        typeof result?.corrected === 'string' ? result.corrected.trim() : '';
      const quality = typeof result?.quality === 'string' ? result.quality : 'unknown';
      if (
        quality !== 'good' &&
        corrected &&
        corrected !== entry.translation &&
        assessReasoningTranslation(prepareReasoningTranslation(text), corrected).acceptable
      ) {
        entry.translation = corrected;
        entry.updatedAt = Date.now();
      }
      entry.reviewed = true;
      entry.reviewModel = model;
      entry.reviewedAt = Date.now();
      updated += 1;
    }
    if (updated > 0) saveCache();
    return updated;
  }

  function installed() {
    const configured = process.env.LEAFCODE_TRANSLATION_PYTHON?.trim();
    const python = configured || (process.platform === 'win32'
      ? join(dataDir, 'translation', 'venv', 'Scripts', 'python.exe')
      : join(dataDir, 'translation', 'venv', 'bin', 'python'));
    return existsSync(python)
      && existsSync(join(packagesDir, 'en_ja', 'metadata.json'))
      && existsSync(join(packagesDir, 'en_ja', 'model', 'model.bin'));
  }

  function status() {
    loadCache();
    loadOverrides();
    let unreviewed = 0;
    for (const entry of cache.values()) if (!entry.reviewed) unreviewed += 1;
    return {
      state,
      available: existsSync(script),
      installed: installed(),
      installState: installProc ? 'running' : installError ? 'error' : 'idle',
      installError,
      cacheEntries: cache.size,
      unreviewedEntries: unreviewed,
      overrideEntries: overrides.size,
      pipelineVersion: TRANSLATION_PIPELINE_VERSION,
      modelVersion: modelVersion(),
      configuredPython: process.env.LEAFCODE_TRANSLATION_PYTHON || null,
      error: lastError,
    };
  }

  function rejectPending(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending = new Map();
  }

  function stop() {
    const oldChild = child;
    child = null;
    if (reader) {
      reader.close();
      reader = null;
    }
    rejectPending(new Error('translation service stopped'));
    if (oldChild && !oldChild.killed) {
      oldChild.removeAllListeners('exit');
      oldChild.removeAllListeners('error');
      oldChild.kill();
    }
    state = 'stopped';
  }

  function start() {
    if (state === 'starting' || (child && state === 'ready')) return;
    if (!existsSync(script)) throw new Error('translation service script is missing');
    stop();
    const python = executable(dataDir);
    state = 'starting';
    lastError = null;
    const newChild = spawn(python.file, [...python.args, script, '--packages-dir', packagesDir], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    child = newChild;
    reader = createInterface({ input: newChild.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      const item = pending.get(response?.id);
      if (!item) return;
      pending.delete(response.id);
      clearTimeout(item.timer);
      response.ok ? item.resolve(response) : item.reject(new Error(response.error || 'translation failed'));
    });
    newChild.stderr.on('data', (chunk) => log(`[translation] ${String(chunk).trim()}`));
    newChild.once('error', (error) => {
      if (child !== newChild) return;
      lastError = error instanceof Error ? error.message : String(error);
      state = 'error';
      rejectPending(error);
    });
    newChild.once('exit', (code) => {
      if (child !== newChild) return;
      if (state !== 'stopped') {
        lastError = `translation service exited (${code ?? 'unknown'})`;
        state = 'error';
        rejectPending(new Error(lastError));
      }
      child = null;
      reader = null;
    });
    state = 'ready';
  }

  async function requestTranslation(texts) {
    start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('translation timed out'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({
        v: 1,
        id,
        type: 'translate',
        source: SOURCE_CODE,
        target: TARGET_CODE,
        texts,
      }) + '\n';
      void enqueueStdinWrite(line).catch((error) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }

  /** Translate prepared segments in protocol-sized batches, preserving order. */
  async function requestPreparedTranslations(prepared) {
    const translations = new Array(prepared.length);
    const batches = [];
    let offset = 0;
    while (offset < prepared.length) {
      const batch = [];
      let chars = 0;
      while (
        offset + batch.length < prepared.length &&
        batch.length < MAX_ENGINE_ITEMS
      ) {
        const item = prepared[offset + batch.length];
        if (
          batch.length > 0 &&
          chars + item.engineText.length > MAX_ENGINE_CHARS
        ) {
          break;
        }
        batch.push(item);
        chars += item.engineText.length;
      }
      if (batch.length === 0) {
        throw new Error('translation segment is too large');
      }
      batches.push({ offset, batch });
      offset += batch.length;
    }

    for (const { offset: batchOffset, batch } of batches) {
      const response = await requestTranslation(batch.map((item) => item.engineText));
      if (
        !Array.isArray(response?.translations) ||
        response.translations.length !== batch.length
      ) {
        throw new Error('translation response is incomplete');
      }
      batch.forEach((_, batchIndex) => {
        const raw = response.translations[batchIndex];
        if (typeof raw !== 'string' || !raw.trim()) {
          throw new Error('translation response is empty');
        }
        translations[batchOffset + batchIndex] = raw;
      });
    }
    return translations;
  }

  async function translate(texts) {
    loadCache();
    loadOverrides();
    const translations = new Array(texts.length);
    const fallbacks = new Array(texts.length).fill(false);
    const overridden = new Array(texts.length).fill(false);
    const waiting = [];
    const missing = [];
    const missingByKey = new Map();

    texts.forEach((text, index) => {
      const corrected = getOverride(text);
      if (corrected !== null) {
        translations[index] = corrected;
        overridden[index] = true;
        return;
      }
      const cached = getCached(text);
      if (cached !== null) {
        translations[index] = cached;
        return;
      }

      const key = cacheKey(text);
      const existing = inFlight.get(key);
      if (existing) {
        waiting.push(existing.then((result) => {
          translations[index] = result.translation;
          fallbacks[index] = result.fallback;
        }));
        return;
      }

      let item = missingByKey.get(key);
      if (!item) {
        item = { key, text, indices: [index] };
        missingByKey.set(key, item);
        missing.push(item);
      } else {
        item.indices.push(index);
      }
    });

    if (missing.length > 0) {
      const batch = (async () => {
        const firstPlans = missing.map((item) =>
          splitReasoningTranslationText(item.text).map((segment) =>
            prepareReasoningTranslation(segment)));
        const firstPrepared = firstPlans.flat();
        const firstRaw = await requestPreparedTranslations(firstPrepared);
        let rawOffset = 0;
        const segmentResults = firstPlans.map((plan) =>
          plan.map((prepared) => {
            const raw = firstRaw[rawOffset++];
            const translation = finalizeReasoningTranslation(prepared, raw);
            const quality = assessReasoningTranslation(prepared, translation);
            return {
              prepared,
              translation,
              acceptable: quality.acceptable,
            };
          }));

        const composeResults = () =>
          segmentResults.map((segments, index) => {
            const acceptable = segments.every((segment) => segment.acceptable);
            return acceptable
              ? {
                  translation: segments
                    .map((segment) => segment.translation)
                    .join('\n\n'),
                  fallback: false,
                  acceptable: true,
                }
              : {
                  translation: missing[index].text,
                  fallback: true,
                  acceptable: false,
                };
          });

        let results = composeResults();
        const retryRefs = [];
        const retryPrepared = [];
        segmentResults.forEach((segments, itemIndex) => {
          segments.forEach((segment, segmentIndex) => {
            if (segment.acceptable) return;
            retryRefs.push({ itemIndex, segmentIndex });
            retryPrepared.push(
              prepareReasoningTranslation(segment.prepared.original, { retry: true }),
            );
          });
        });

        if (retryPrepared.length > 0) {
          const retryRaw = await requestPreparedTranslations(retryPrepared);
          retryRaw.forEach((raw, retryIndex) => {
            const ref = retryRefs[retryIndex];
            const prepared = retryPrepared[retryIndex];
            if (!ref || typeof raw !== 'string' || !raw.trim()) return;
            const translation = finalizeReasoningTranslation(prepared, raw);
            const quality = assessReasoningTranslation(prepared, translation);
            if (quality.acceptable) {
              segmentResults[ref.itemIndex][ref.segmentIndex] = {
                prepared,
                translation,
                acceptable: true,
              };
            }
          });
          results = composeResults();
        }

        let cacheChanged = false;
        results.forEach((result, index) => {
          if (!result.acceptable) return;
          remember(missing[index].text, result.translation, { save: false });
          cacheChanged = true;
        });
        if (cacheChanged) saveCache();
        return results;
      })();

      missing.forEach((item, index) => {
        let valuePromise;
        valuePromise = batch
          .then((values) => values[index])
          .finally(() => {
            if (inFlight.get(item.key) === valuePromise) inFlight.delete(item.key);
          });
        inFlight.set(item.key, valuePromise);
        waiting.push(valuePromise.then((result) => {
          for (const resultIndex of item.indices) {
            translations[resultIndex] = result.translation;
            fallbacks[resultIndex] = result.fallback;
          }
        }));
      });
    }

    await Promise.all(waiting);
    return { v: 1, id: randomUUID(), ok: true, translations, fallbacks, overridden };
  }

  /**
   * Run translation/install.py in the background (pip + Argos model download,
   * minutes). Returns immediately; status().installState tracks progress.
   */
  function install() {
    if (installProc) return { state: 'running' };
    const installer = join(repoRoot, 'translation', 'install.py');
    if (!existsSync(installer)) throw new Error('translation installer is missing');
    const python = executable(dataDir);
    installError = null;
    installStderr = '';
    const child = spawn(python.file, [...python.args, installer, '--data-dir', dataDir], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    installProc = child;
    child.stderr.on('data', (chunk) => {
      installStderr = `${installStderr}${String(chunk)}`.slice(-4_000);
    });
    const fail = (message) => {
      installError = `${message}${installStderr.trim() ? `: ${installStderr.trim().slice(-500)}` : ''}`;
      if (installProc === child) installProc = null;
    };
    child.once('error', (error) => {
      fail(`installer failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.once('exit', (code) => {
      if (installProc !== child) return;
      installProc = null;
      if (code !== 0) fail(`install.py exited (${code ?? 'unknown'})`);
    });
    log('[translation] install started');
    return { state: 'running' };
  }

  return {
    status,
    start,
    stop,
    translate,
    setOverride,
    unreviewedEntries,
    skipTrivialReviews,
    applyReviewResults,
    install,
  };
}
