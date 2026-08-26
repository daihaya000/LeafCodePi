import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { AccountRuntimeManager } from "./account-runtime-manager";

type FakeRuntime = { id: string };

function fakeRuntime(id: string): never {
  // ModelRuntime の形状は使わないため最小スタブを流用する
  return id as never;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AccountRuntimeManager", () => {
  it("creates once per account and reuses on later acquires", async () => {
    let creations = 0;
    const manager = new AccountRuntimeManager(async (id) => {
      creations += 1;
      return fakeRuntime(`rt-${id}`);
    });

    const first = await manager.acquire("a");
    const second = await manager.acquire("a");
    assert.equal(creations, 1);
    assert.equal(first, second);

    manager.release("a");
    manager.release("a");
    const third = await manager.acquire("a");
    assert.equal(third, first);
    assert.equal(creations, 1);
  });

  it("shares one creation between concurrent acquires and counts refs", async () => {
    const gate = deferred<FakeRuntime>();
    let creations = 0;
    const manager = new AccountRuntimeManager(async () => {
      creations += 1;
      return gate.promise as Promise<never>;
    });

    const p1 = manager.acquire("a");
    const p2 = manager.acquire("a");
    gate.resolve(fakeRuntime("rt-a"));
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(creations, 1);
    assert.equal(r1, r2);

    // 両者の分だけ参照が付いている: 片方 release では破棄されない
    manager.release("a");
    const b = await manager.acquire("b");
    assert.equal(manager.size(), 2); // a(refs1) + b
    void b;
  });

  it("propagates creation failure and allows retry", async () => {
    let attempts = 0;
    const manager = new AccountRuntimeManager(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return fakeRuntime("rt-a");
    });

    await assert.rejects(() => manager.acquire("a"), /boom/);
    const runtime = await manager.acquire("a");
    assert.equal(runtime, fakeRuntime("rt-a"));
    assert.equal(attempts, 2);
  });

  it("evicts oldest idle runtimes beyond the cap but keeps referenced ones", async () => {
    const manager = new AccountRuntimeManager(async (id) => fakeRuntime(`rt-${id}`));

    const held = await manager.acquire("held"); // 常時参照中
    for (const id of ["i1", "i2", "i3"]) {
      await manager.acquire(id);
      manager.release(id);
    }
    manager.evictIdle();
    // idle 上限 2: 最古の i1 が落ち、held（参照中）と i2/i3 が残る
    assert.equal(manager.peek("i1"), undefined);
    assert.ok(manager.peek("i2"));
    assert.ok(manager.peek("i3"));
    assert.equal(manager.peek("held"), held);
    assert.equal(manager.size(), 3);
  });
});
