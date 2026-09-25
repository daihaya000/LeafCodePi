import { getJson, sendJson } from "./client";

/**
 * 設定同期の共通パターン（REFACTORING_PLAN P4-d / IMPROVEMENT 2-2）。
 *
 * localStorage 即時反映（同期 read/write + CustomEvent 通知）と、サーバ
 * `settings` 表への write queue 直列化ミラーを 1 つのヘルパーに集約する。
 * `default-model.ts` の実装を正本として再利用し、各設定は宣言的に定義する
 * ことで「片方だけ localStorage、もう片方はサーバのみ」というドリフトを防ぐ。
 *
 * 永続化ポリシー: サーバ `settings` 表が正本、localStorage は同期読み取り用キャッシュ。
 * 起動時はサーバ描画で埋め込んだ値（primeServerSettings）、タブ復帰時は再取得した値で上書きする。
 * 未送信の書き込みがあるキーはサーバ値で戻さず再送を優先する。
 * サーバ書き込み失敗は非致命的（localStorage は既に更新済み、次回hydrate時に再送）。
 */
/** 4xx（タイムアウト・レート制限を除く）は再送しても成功しない。 */
function isRejected(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** 第2引数はスナップショット取得開始時点の書き込み番号。これより後のローカル書き込みは戻さない。 */
type ServerSettingApplier = (value: string | null, snapshotSeq: number) => void;
type SettingsSnapshot = Record<string, string | null>;

const appliers = new Map<string, ServerSettingApplier[]>();
let snapshot: SettingsSnapshot | null = null;
let snapshotSeq = 0;
let hydration: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
/** このタブでのユーザー起点のサーバ書き込み番号（取得中に変更された値を古いスナップショットで戻さないため）。 */
let localWriteSeq = 0;

function nextLocalWriteSeq(): number {
  localWriteSeq += 1;
  return localWriteSeq;
}

function applySnapshot(key: string, apply: ServerSettingApplier): void {
  if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, key)) return;
  const value = snapshot[key];
  try {
    apply(typeof value === "string" && value.length > 0 ? value : null, snapshotSeq);
  } catch (err) {
    console.warn(`setting hydrate failed: ${key}`, err);
  }
}

function applyAll(values: unknown, seq: number): void {
  snapshot = values && typeof values === "object" && !Array.isArray(values)
    ? (values as SettingsSnapshot)
    : {};
  snapshotSeq = seq;
  for (const [key, list] of appliers) {
    for (const apply of list) applySnapshot(key, apply);
  }
}

/**
 * サーバ設定キーの反映関数を登録する。スナップショット適用済みなら即時に反映する
 * （遅延importされたモジュールも起動時スナップショットに追従させるため）。
 */
export function registerServerSetting(key: string, apply: ServerSettingApplier): void {
  const list = appliers.get(key) ?? [];
  list.push(apply);
  appliers.set(key, list);
  applySnapshot(key, apply);
}

/**
 * サーバ描画時に埋め込まれた設定スナップショットを同期的に適用する。
 * これにより起動時に取得待ちの空白画面を出さずにサーバ値で起動できる。
 */
export function primeServerSettings(values: SettingsSnapshot): void {
  if (typeof window === "undefined" || hydration) return;
  applyAll(values, localWriteSeq);
  hydration = Promise.resolve();
}

async function fetchAndApply(): Promise<void> {
  const seq = localWriteSeq;
  const data = await getJson<{ values?: SettingsSnapshot }>("/api/settings", undefined, { coalesce: false });
  applyAll(data?.values, seq);
}

/** `/api/settings` を一括取得して登録済み設定へ反映する。起動ごとに1回（失敗時は次回再試行）。 */
export function hydrateServerSettings(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  hydration ??= fetchAndApply().catch((err) => {
    hydration = null;
    console.warn("settings hydrate failed", err);
  });
  return hydration;
}

/** 他PCでの変更を取り込むため再取得する（タブ復帰時など）。同時実行は1つに束ねる。 */
export function refreshServerSettings(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  refreshing ??= fetchAndApply()
    .catch((err) => console.warn("settings refresh failed", err))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** テスト用: hydrate状態を初期化する（登録済み applier は保持）。 */
export function resetServerSettingsHydration(): void {
  snapshot = null;
  snapshotSeq = 0;
  hydration = null;
  refreshing = null;
}

export function createSettingSync(options: {
  storageKey: string;
  serverPath: string;
  eventName: string;
  /** false なら起動時hydrateしない（起動時に別の既定値で毎回上書きされる値など）。 */
  hydrate?: boolean;
}) {
  const { storageKey, serverPath, eventName } = options;
  const pendingKey = `${storageKey}:server-pending`;
  const syncedKey = `${storageKey}:server-synced`;
  let writeQueue = Promise.resolve();
  let memoryPending: { encoded: string; value: string | null } | null = null;
  let lastLocalWrite = 0;

  function readPending(): { encoded: string; value: string | null } | null {
    if (typeof window === "undefined") return null;
    if (memoryPending) return memoryPending;
    try {
      const encoded = localStorage.getItem(pendingKey);
      if (encoded === null) return null;
      const value = JSON.parse(encoded) as unknown;
      return value === null || typeof value === "string" ? { encoded, value } : null;
    } catch {
      return null;
    }
  }

  function setPending(value: string | null): void {
    const encoded = JSON.stringify(value);
    memoryPending = { encoded, value };
    try {
      localStorage.setItem(pendingKey, encoded);
    } catch {
      /* memoryPending から即時再送する。 */
    }
  }

  function clearPending(pending: { encoded: string }): void {
    if (memoryPending?.encoded === pending.encoded) memoryPending = null;
    try {
      if (localStorage.getItem(pendingKey) === pending.encoded) {
        localStorage.removeItem(pendingKey);
      }
    } catch {
      /* memoryPending は上で解消済み。 */
    }
  }

  async function flushPending(): Promise<void> {
    const delays = [0, 250, 1_000, 3_000];
    for (const delay of delays) {
      const pending = readPending();
      if (!pending) return;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await sendJson(serverPath, { value: pending.value }, "PUT");
        clearPending(pending);
        return;
      } catch (err) {
        if (isRejected(err)) {
          // 不正値など再送しても通らない値は破棄し、hydrate がサーバ値を適用できるようにする。
          clearPending(pending);
          console.warn(`${eventName} server rejected value`, err);
          return;
        }
        if (delay === delays.at(-1)) {
          console.warn(`${eventName} server write failed`, err);
        }
      }
    }
  }

  function queuePendingFlush(): Promise<void> {
    const operation = writeQueue.then(flushPending);
    writeQueue = operation.catch(() => undefined);
    return operation;
  }

  /** 同期読み取り。未設定・ブラウザ外・失敗時は null。 */
  function read(): string | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (typeof raw === "string" && raw.length > 0) return raw;
    } catch {
      /* ignore */
    }
    return null;
  }

  /** localStorage 即時反映 + CustomEvent 通知。 */
  function write(value: string | null): void {
    if (typeof window === "undefined") return;
    try {
      if (value) {
        localStorage.setItem(storageKey, value);
      } else {
        localStorage.removeItem(storageKey);
      }
      window.dispatchEvent(new CustomEvent(eventName, { detail: value ?? "" }));
    } catch {
      /* ignore */
    }
  }

  /**
   * サーバ settings 表から読む。このタブでキュー済みの書き込みを待ってから
   * GET するので、進行中の PUT より先に GET が届いて値が復活することはない。
   */
  async function readFromServer(): Promise<string | null> {
    if (typeof window === "undefined") return null;
    await writeQueue.catch(() => undefined);
    if (readPending()) {
      await queuePendingFlush();
      // 再起動中などで再送できなければ、古いサーバ値でローカル値を戻さない。
      if (readPending()) return read();
    }
    try {
      const data = await getJson<{ value: string | null }>(serverPath);
      const value = data?.value;
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** サーバ settings 表へ書き込む。失敗値はlocalStorageに残し、次回読込時にも再送する。 */
  async function writeToServer(value: string | null): Promise<void> {
    if (typeof window === "undefined") return;
    lastLocalWrite = nextLocalWriteSeq();
    setPending(value);
    await queuePendingFlush();
  }

  function markSynced(): boolean {
    try {
      if (localStorage.getItem(syncedKey) === "1") return true;
      localStorage.setItem(syncedKey, "1");
    } catch {
      /* ignore */
    }
    return false;
  }

  /** 起動時スナップショットの反映。初回だけ、サーバ未保存のローカル値をサーバへ移行する。 */
  function applyServerValue(serverValue: string | null, seq: number): void {
    // 取得開始後にこのタブで変更した値は、古いスナップショットで戻さない。
    if (lastLocalWrite > seq) return;
    if (readPending()) {
      void queuePendingFlush();
      return;
    }
    const local = read();
    const alreadySynced = markSynced();
    if (serverValue === null && local !== null && !alreadySynced) {
      void writeToServer(local);
      return;
    }
    if (serverValue !== local) write(serverValue);
  }

  if (options.hydrate !== false) {
    registerServerSetting(serverPath.slice(serverPath.lastIndexOf("/") + 1), applyServerValue);
  }

  return { read, write, readFromServer, writeToServer };
}

export type SettingSync = ReturnType<typeof createSettingSync>;
