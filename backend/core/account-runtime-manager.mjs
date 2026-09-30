/** SDK-neutral account ownership. The runtime creator is injected by the host. */
export class AccountRuntimeManager {
  constructor(create, maxIdleRuntimes = 2) {
    this.create = create;
    this.maxIdleRuntimes = maxIdleRuntimes;
    this.entries = new Map();
    this.inflight = new Map();
  }

  async ensure(accountId) {
    const existing = this.entries.get(accountId);
    if (existing) {
      this.entries.delete(accountId);
      this.entries.set(accountId, existing);
      return existing.runtime;
    }
    let promise = this.inflight.get(accountId);
    if (!promise) {
      promise = this.create(accountId);
      this.inflight.set(accountId, promise);
    }
    let runtime;
    try {
      runtime = await promise;
    } catch (error) {
      if (this.inflight.get(accountId) === promise) this.inflight.delete(accountId);
      throw error;
    }
    if (this.inflight.get(accountId) === promise) this.inflight.delete(accountId);
    const current = this.entries.get(accountId);
    if (current && current.runtime === runtime) {
      this.entries.delete(accountId);
      this.entries.set(accountId, current);
      return runtime;
    }
    this.evictIdle();
    this.entries.set(accountId, { runtime, refs: 0 });
    return runtime;
  }

  async acquire(accountId) {
    // An idle eviction can race the continuation after ensure().
    while (true) {
      const runtime = await this.ensure(accountId);
      const entry = this.entries.get(accountId);
      if (!entry || entry.runtime !== runtime) continue;
      entry.refs += 1;
      return runtime;
    }
  }

  release(accountId) {
    const entry = this.entries.get(accountId);
    if (entry && entry.refs > 0) entry.refs -= 1;
  }

  evictIdle() {
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.refs <= 0);
    let excess = idle.length - this.maxIdleRuntimes;
    for (const [id] of idle) {
      if (excess <= 0) break;
      this.entries.delete(id);
      excess -= 1;
    }
  }

  peek(accountId) {
    return this.entries.get(accountId)?.runtime;
  }

  size() {
    return this.entries.size;
  }
}
