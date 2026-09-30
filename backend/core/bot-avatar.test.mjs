import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoEyeColor, avatarColorForId, AVATAR_IMAGE_ACCEPT, BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES,
  isAvatarColor, isAvatarEyeColor, isAvatarImage, isAvatarShape, MAX_AVATAR_IMAGE_BYTES, randomAvatarColor,
} from "./bot-avatar.mjs";

test("the palette and shape vocabulary are the persisted contract", () => {
  assert.deepEqual(BOT_AVATAR_COLORS, [
    "#3B82F6", "#8B5CF6", "#EC4899", "#F97316", "#10B981", "#06B6D4",
    "#EAB308", "#EF4444", "#111111", "#A67C52", "#14B8A6", "#949494",
  ]);
  assert.equal(new Set(BOT_AVATAR_COLORS).size, BOT_AVATAR_COLORS.length);
  assert.deepEqual(BOT_AVATAR_SHAPES.map((shape) => shape.id), [
    "circle", "leaf", "oval", "square", "capsule", "triangle", "hexagon", "cloud", "droplet",
  ]);
  // Every shape carries the drawing data the UI reads directly.
  for (const shape of BOT_AVATAR_SHAPES) {
    assert.equal(typeof shape.label, "string");
    assert.ok(shape.path.startsWith("M"));
    assert.ok(Number.isInteger(shape.eyeOffset));
  }
  assert.equal(AVATAR_IMAGE_ACCEPT, "image/png,image/jpeg,image/gif,image/webp");
  assert.equal(MAX_AVATAR_IMAGE_BYTES, 2 * 1024 * 1024);
});

test("shape and colour validation accept only the known vocabulary", () => {
  for (const shape of BOT_AVATAR_SHAPES) assert.equal(isAvatarShape(shape.id), true, shape.id);
  for (const bad of ["", "Circle", "star", 1, null, undefined, {}]) assert.equal(isAvatarShape(bad), false, String(bad));
  for (const color of BOT_AVATAR_COLORS) assert.equal(isAvatarColor(color), true, color);
  for (const bad of ["", "#FFF", "#GGGGGG", "3B82F6", "#3B82F6 ", 7, null]) assert.equal(isAvatarColor(bad), false, String(bad));
  assert.equal(isAvatarColor("#abcdef"), true, "validation is case-insensitive");
});

test("the id hash picks a stable palette colour, and every id form is handled", () => {
  assert.equal(avatarColorForId("0f0f0f0f-aaaa-bbbb-cccc-000000000001"), avatarColorForId("0f0f0f0f-aaaa-bbbb-cccc-000000000001"));
  assert.ok(BOT_AVATAR_COLORS.includes(avatarColorForId("bot-1")));
  // Unicode ids hash by code point, not UTF-16 unit.
  assert.equal(avatarColorForId("😀"), avatarColorForId("😀"));
  for (const id of ["", "a", "日本語のボット", "😀🎉"]) assert.ok(BOT_AVATAR_COLORS.includes(avatarColorForId(id)), id);
});

test("the random colour can avoid the current one and never leaves the palette", () => {
  for (let index = 0; index < 50; index += 1) {
    const color = randomAvatarColor();
    assert.ok(BOT_AVATAR_COLORS.includes(color));
    assert.notEqual(randomAvatarColor(color), color);
  }
  assert.ok(BOT_AVATAR_COLORS.includes(randomAvatarColor("not-a-color")));
});

test("eye ink is white on dark bodies and black on pale ones", () => {
  assert.equal(autoEyeColor("#111111"), "#FFFFFF");
  assert.equal(autoEyeColor("#FFFFFF"), "#000000");
  assert.equal(autoEyeColor("#EAB308"), "#000000");
  assert.equal(autoEyeColor("not-a-color"), "#FFFFFF");
  assert.equal(isAvatarEyeColor("#ffffff"), true);
  assert.equal(isAvatarEyeColor("#000000"), true);
  for (const bad of ["#FFF", "#123456", "", null, 1]) assert.equal(isAvatarEyeColor(bad), false, String(bad));
});

test("avatar images accept only small inline base64 of the four allowed formats", () => {
  assert.equal(isAvatarImage("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(isAvatarImage("data:image/webp;base64,AAAA"), true);
  for (const bad of [
    "", "https://example.com/a.png", "data:image/svg+xml;base64,AAAA", "data:image/png,AAAA",
    "data:image/png;base64,AA AA", 1, null,
  ]) assert.equal(isAvatarImage(bad), false, String(bad));
  // The length cap is on the data URL itself: one byte over is rejected.
  const body = "A".repeat(3_000_000 - "data:image/png;base64,".length);
  assert.equal(isAvatarImage(`data:image/png;base64,${body}`), true);
  assert.equal(isAvatarImage(`data:image/png;base64,${body}A`), false);
});
