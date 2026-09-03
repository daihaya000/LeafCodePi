import { getJson, sendJson } from "./client";

/**
 * 設定同期の共通パターン（REFACTORING_PLAN P4-d / IMPROVEMENT 2-2）。
 *
 * localStorage 即時反映（同期 read/write + CustomEvent 通知）と、サーバ
 * `settings` 表への write queue 直列化ミラーを 1 つのヘルパーに集約する。
 * `default-model.ts` の実装を正本として再利用し、各設定は宣言的に定義する
 * ことで「片方だけ localStorage、もう片方はサーバのみ」というドリフトを防ぐ。
 *
 * 永続化ポリシー: localStorage が同期読み取りの正本、サーバは永続バックアップ。
 * サーバ書き込み失敗は非致命的（localStorage は既に更新済み）。
 */
export function createSettingSync(options: {
  storageKey: string;
  serverPath: string;
  eventName: string;
}) {
  const { storageKey, serverPath, eventName } = options;
  const pendingKey = `${storageKey}:server-pending`;
  let writeQueue = Promise.resolve();
  let memoryPending: { encoded: string; value: string | null } | null = null;

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

  async function flushPending(): Promise<void> {
    const delays = [0, 250, 1_000, 3_000];
    for (const delay of delays) {
      const pending = readPending();
      if (!pending) return;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await sendJson(serverPath, { value: pending.value }, "PUT");
        if (memoryPending?.encoded === pending.encoded) memoryPending = null;
        try {
          if (localStorage.getItem(pendingKey) === pending.encoded) {
            localStorage.removeItem(pendingKey);
          }
        } catch {
          /* memoryPending は上で解消済み。 */
        }
        return;
      } catch (err) {
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
    setPending(value);
    await queuePendingFlush();
  }

  return { read, write, readFromServer, writeToServer };
}

export type SettingSync = ReturnType<typeof createSettingSync>;
