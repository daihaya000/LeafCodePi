import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_INTERCOM_TRIGGER_POLICIES, botIntercomPresence, shouldWakeIdleDelivery } from "./bot-intercom-policy.mjs";

test("the trigger policies are the documented three", () => {
  assert.deepEqual([...BOT_INTERCOM_TRIGGER_POLICIES], ["never", "replies", "always"]);
});

test("never silences every kind, always wakes every kind", () => {
  for (const kind of ["ask", "tell", "reply", "unknown"]) {
    assert.equal(shouldWakeIdleDelivery("never", kind), false, kind);
    assert.equal(shouldWakeIdleDelivery("always", kind), true, kind);
  }
});

test("the default replies policy wakes only for an ask", () => {
  assert.equal(shouldWakeIdleDelivery("replies", "ask"), true);
  for (const kind of ["tell", "reply", "notice", ""]) {
    assert.equal(shouldWakeIdleDelivery("replies", kind), false, kind);
  }
});

test("an unknown or missing policy behaves like replies", () => {
  for (const policy of [undefined, null, "", "REPLIES", "sometimes"]) {
    assert.equal(shouldWakeIdleDelivery(policy, "ask"), true, String(policy));
    assert.equal(shouldWakeIdleDelivery(policy, "tell"), false, String(policy));
  }
});

test("without a live session the Bot is offline, whatever else is true", () => {
  for (const waiting of [true, false]) {
    for (const busy of [true, false]) {
      for (const roomBusy of [true, false]) {
        assert.equal(botIntercomPresence({ resident: false, waiting, busy, roomBusy }), "offline");
      }
    }
  }
  assert.equal(botIntercomPresence({ resident: false, waiting: false, busy: false, roomBusy: false }), "offline");
});

test("a resident Bot is busy for any of waiting, prompting, or an active Room turn", () => {
  assert.equal(botIntercomPresence({ resident: true, waiting: false, busy: false, roomBusy: false }), "online");
  assert.equal(botIntercomPresence({ resident: true, waiting: true, busy: false, roomBusy: false }), "busy");
  assert.equal(botIntercomPresence({ resident: true, waiting: false, busy: true, roomBusy: false }), "busy");
  assert.equal(botIntercomPresence({ resident: true, waiting: false, busy: false, roomBusy: true }), "busy");
  assert.equal(botIntercomPresence({ resident: true, waiting: true, busy: true, roomBusy: true }), "busy");
});

test("only an explicit true counts for the presence flags", () => {
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(botIntercomPresence({ resident: value, waiting: false, busy: false, roomBusy: false }), "offline", String(value));
    assert.equal(botIntercomPresence({ resident: true, waiting: value, busy: false, roomBusy: false }), "online", String(value));
    assert.equal(botIntercomPresence({ resident: true, waiting: false, busy: value, roomBusy: false }), "online", String(value));
    assert.equal(botIntercomPresence({ resident: true, waiting: false, busy: false, roomBusy: value }), "online", String(value));
  }
});
