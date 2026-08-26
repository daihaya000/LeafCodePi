import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * アカウント別 ModelRuntime の生成・再利用・破棄を管理する
 * （docs/plans/multi-account.md Phase 6）。
 *
 * - アカウントごとに 1 インスタンスを遅延生成し、同時 acquire を 1 生成に統合する
 * - 実行中タスクからの参照（refs）があるランタイムは破棄しない
 * - 参照の無いランタイムが上限（MAX_IDLE_RUNTIMES）を超えたら古いものから破棄する
 *
 * harness 側の既定シングルトンとは独立しており、default はこのクラスの外で管理する。
 */
const MAX_IDLE_RUNTIMES = 2;

type Entry = {
  runtime: ModelRuntime;
  /** 実行中タスクなど、破棄を禁じる保持者の数。 */
  refs: number;
};

export class AccountRuntimeManager {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<ModelRuntime>>();

  constructor(
    /** 実際の生成は SDK 依存のため注入する（テストでスタブ可能）。 */
    private readonly create: (accountId: string) => Promise<ModelRuntime>,
    private readonly maxIdleRuntimes = MAX_IDLE_RUNTIMES,
  ) {}

  /** ランタイムを取得する（参照カウントなし。一時的な読み取り用）。なければ生成する。 */
  async ensure(accountId: string): Promise<ModelRuntime> {
    const existing = this.entries.get(accountId);
    if (existing) return existing.runtime;

    // 同時呼び出しを 1 生成に統合する。
    let promise = this.inflight.get(accountId);
    if (!promise) {
      promise = this.create(accountId);
      this.inflight.set(accountId, promise);
    }
    let runtime: ModelRuntime;
    try {
      runtime = await promise;
    } catch (error) {
      if (this.inflight.get(accountId) === promise) this.inflight.delete(accountId);
      throw error;
    }
    if (this.inflight.get(accountId) === promise) this.inflight.delete(accountId);

    // await 中に別呼び出しが登録済みならそれを使う（二重登録の回避）。
    const current = this.entries.get(accountId);
    if (current && current.runtime === runtime) return runtime;
    this.evictIdle();
    this.entries.set(accountId, { runtime, refs: 0 });
    return runtime;
  }

  /** ランタイムを取得し、呼び出し元の参照を 1 加算する（セッション保持用）。対応する release() を必ず呼ぶこと。 */
  async acquire(accountId: string): Promise<ModelRuntime> {
    const runtime = await this.ensure(accountId);
    this.entries.get(accountId)!.refs += 1;
    return runtime;
  }

  /** acquire に対応する参照を 1 減らす。0 になっても即座には破棄しない。 */
  release(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (entry && entry.refs > 0) entry.refs -= 1;
  }

  /** 参照の無いランタイムが上限を超えていれば、古いものから破棄する。 */
  evictIdle(): void {
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.refs <= 0);
    let excess = idle.length - this.maxIdleRuntimes;
    for (const [id] of idle) {
      if (excess <= 0) break;
      this.entries.delete(id);
      excess -= 1;
    }
  }

  peek(accountId: string): ModelRuntime | undefined {
    return this.entries.get(accountId)?.runtime;
  }

  size(): number {
    return this.entries.size;
  }
}
