// Generate LeafCodePi branded icons from icons/LeafCodePi.svg:
// tray ICO (host/src/icon.json), PWA PNGs, favicon.ico, and web/public/icon.svg.
// Does NOT touch host/src/llama-server-icon.json (llama-server tray stays distinct).
// Usage: node scripts/gen-icons.mjs
import { copyFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "web", "package.json"));
const sharp = require("sharp");

const SOURCE = join(ROOT, "icons", "LeafCodePi.svg");

/** Rounded-corner mask (radius 22% of size). */
function roundedMask(size) {
  const radius = Math.round(size * 0.22);
  return Buffer.from(
    `<svg width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#000"/>` +
      `</svg>`,
  );
}

async function renderRgba(size) {
  return sharp(SOURCE)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .composite([{ input: roundedMask(size), blend: "dest-in" }])
    .raw()
    .ensureAlpha()
    .toBuffer();
}

async function renderPng(size) {
  return sharp(SOURCE)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .composite([{ input: roundedMask(size), blend: "dest-in" }])
    .png()
    .toBuffer();
}

function icoEntry(size, rgba) {
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4 + maskRowBytes * size, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const mask = Buffer.alloc(maskRowBytes * size, 0);
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(sizes, rgbaBySize) {
  const entries = sizes.map((s) => ({ size: s, data: icoEntry(s, rgbaBySize.get(s)) }));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirEntries = entries.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.data)]);
}

async function main() {
  const sizes = [16, 32, 48, 128, 180, 192, 512];
  const rgbaBySize = new Map();
  for (const s of sizes) rgbaBySize.set(s, await renderRgba(s));

  const trayIco = buildIco([16, 32], rgbaBySize);
  writeFileSync(
    join(ROOT, "host", "src", "icon.json"),
    `${JSON.stringify({ base64: trayIco.toString("base64") })}\n`,
  );

  writeFileSync(join(ROOT, "web", "src", "app", "favicon.ico"), buildIco([16, 32], rgbaBySize));

  for (const s of [192, 512]) {
    writeFileSync(join(ROOT, "web", "public", `icon-${s}.png`), await renderPng(s));
  }
  writeFileSync(join(ROOT, "web", "public", "apple-touch-icon.png"), await renderPng(180));

  // Keep the public SVG in sync with the source artwork (UI sidebar / metadata).
  copyFileSync(SOURCE, join(ROOT, "web", "public", "icon.svg"));

  console.log("Generated icons from", SOURCE);
}

main().catch((error) => {
  console.error("Icon generation failed:", error);
  process.exitCode = 1;
});
