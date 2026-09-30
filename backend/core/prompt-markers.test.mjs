import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_PROMPT_PREFIX, HANG_RETRY_PREFIX, isBotPromptText, isHangRetryText, markBotPrompt,
  markHangRetryPrompt, stripBotPromptPrefix, stripHangRetryPrefix, stripPromptMarkers,
} from "./prompt-markers.mjs";

test("marking is idempotent and stripping is safe on unmarked text", () => {
  assert.equal(markBotPrompt("hi"), `${BOT_PROMPT_PREFIX}hi`);
  assert.equal(markBotPrompt(markBotPrompt("hi")), `${BOT_PROMPT_PREFIX}hi`);
  assert.equal(stripBotPromptPrefix("hi"), "hi");
  assert.equal(stripBotPromptPrefix(markBotPrompt("hi")), "hi");
  assert.equal(markHangRetryPrompt("hi"), `${HANG_RETRY_PREFIX}hi`);
  assert.equal(markHangRetryPrompt(markHangRetryPrompt("hi")), `${HANG_RETRY_PREFIX}hi`);
  assert.equal(stripHangRetryPrefix("hi"), "hi");
});

test("an empty prompt still round-trips", () => {
  assert.equal(stripBotPromptPrefix(markBotPrompt("")), "");
  assert.equal(stripPromptMarkers(markHangRetryPrompt(markBotPrompt(""))), "");
});

test("the marker is only recognized at the start of the text", () => {
  assert.equal(stripBotPromptPrefix(`x${BOT_PROMPT_PREFIX}y`), `x${BOT_PROMPT_PREFIX}y`);
  assert.equal(isBotPromptText(`x${BOT_PROMPT_PREFIX}y`), false);
  assert.equal(isHangRetryText(`x${HANG_RETRY_PREFIX}y`), false);
});

test("markers nest: hang resend outside, Bot marker inside", () => {
  const nested = markHangRetryPrompt(markBotPrompt("hi"));
  assert.equal(isHangRetryText(nested), true);
  assert.equal(isBotPromptText(nested), true, "a wrapped Bot prompt is still a Bot prompt");
  assert.equal(stripPromptMarkers(nested), "hi");
});

test("a Bot prompt wrapped by a hang resend is recognized without the wrapper", () => {
  assert.equal(isBotPromptText(markBotPrompt("hi")), true);
  assert.equal(isBotPromptText("hi"), false);
  assert.equal(isHangRetryText(markHangRetryPrompt("hi")), true);
  assert.equal(isHangRetryText("hi"), false);
});

test("each helper leaves the other marker in place", () => {
  const nested = markHangRetryPrompt(markBotPrompt("hi"));
  assert.equal(stripHangRetryPrefix(nested), `${BOT_PROMPT_PREFIX}hi`);
  assert.equal(stripBotPromptPrefix(nested), nested, "the Bot marker is not first, so nothing is stripped");
});

test("the two markers are distinct and end with a newline", () => {
  assert.notEqual(BOT_PROMPT_PREFIX, HANG_RETRY_PREFIX);
  assert.ok(BOT_PROMPT_PREFIX.endsWith("\n"));
  assert.ok(HANG_RETRY_PREFIX.endsWith("\n"));
  assert.ok(!BOT_PROMPT_PREFIX.startsWith(HANG_RETRY_PREFIX));
});
