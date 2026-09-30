import assert from "node:assert/strict";
import { test } from "node:test";
import { promoteMailboxOnAttach } from "./live-lifecycle.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const deps = {
    flushMailbox: (botId) => { calls.push(`flush:${botId}`); },
    warn: (message, error) => { calls.push(`warn:${message}:${error instanceof Error ? error.message : String(error)}`); },
    ...overrides,
  };
  return { calls, deps };
}

test("attaching a 1:1 Bot live promotes its mailbox exactly once", () => {
  const f = fixture();
  assert.equal(promoteMailboxOnAttach("bot:one", f.deps), true);
  assert.deepEqual(f.calls, ["flush:one"]);
});

test("Room and Code attaches never flush the mailbox", () => {
  for (const taskId of ["bot:one:room:main", "bot:one:room:", "code-task", "bot:", "", "xbot:one", "bot:one:extra"]) {
    const f = fixture();
    assert.equal(promoteMailboxOnAttach(taskId, f.deps), false, taskId);
    assert.deepEqual(f.calls, [], taskId);
  }
  assert.equal(promoteMailboxOnAttach(undefined, fixture().deps), false);
});

test("a failing flush is warned with the documented message and does not propagate", () => {
  const failure = new Error("mailbox store down");
  const f = fixture({ flushMailbox: () => { throw failure; } });
  assert.equal(promoteMailboxOnAttach("bot:one", f.deps), true);
  assert.deepEqual(f.calls, ["warn:[bot-intercom] flush after Bot live attach failed:mailbox store down"]);
});

test("a non-Error throw is still reported and swallowed", () => {
  const f = fixture({ flushMailbox: () => { throw "plain failure"; } });
  assert.equal(promoteMailboxOnAttach("bot:one", f.deps), true);
  assert.deepEqual(f.calls, ["warn:[bot-intercom] flush after Bot live attach failed:plain failure"]);
});

test("promotion reports whether it was attempted, independently of the flush outcome", () => {
  const ok = fixture();
  const failing = fixture({ flushMailbox: () => { throw new Error("x"); } });
  const room = fixture();
  assert.equal(promoteMailboxOnAttach("bot:one", ok.deps), true);
  assert.equal(promoteMailboxOnAttach("bot:one", failing.deps), true);
  assert.equal(promoteMailboxOnAttach("bot:one:room:main", room.deps), false);
});
