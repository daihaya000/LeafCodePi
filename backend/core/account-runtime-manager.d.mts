import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Account-scoped runtimes retain the existing acquire/release and idle LRU contract. */
export class AccountRuntimeManager {
  constructor(create: (accountId: string) => Promise<ModelRuntime>, maxIdleRuntimes?: number);
  ensure(accountId: string): Promise<ModelRuntime>;
  acquire(accountId: string): Promise<ModelRuntime>;
  release(accountId: string): void;
  evictIdle(): void;
  peek(accountId: string): ModelRuntime | undefined;
  size(): number;
}
