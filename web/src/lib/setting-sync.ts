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
  let writeQueue = Promise.resolve();

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
    try {
      const data = await getJson<{ value: string | null }>(serverPath);
      const value = data?.value;
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** サーバ settings 表へ書き込む（write queue で直列化）。 */
  async function writeToServer(value: string | null): Promise<void> {
    if (typeof window === "undefined") return;
    const operation = writeQueue.then(async () => {
      try {
        await sendJson(serverPath, { value }, "PUT");
      } catch (err) {
        console.warn(`${eventName} server write failed`, err);
      }
    });
    writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  return { read, write, readFromServer, writeToServer };
}

export type SettingSync = ReturnType<typeof createSettingSync>;
