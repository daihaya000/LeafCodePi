import fs from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unavailable = () => new Error("MCP header name store unavailable");
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_NAMES = 32, MAX_SERVER_NAME = 128, MAX_BYTES = 64 * 1024;

/**
 * INTERNAL private record of the header NAMES written through the native auth API, so removing
 * "saved headers" deletes exactly those names instead of every header a user may have edited into
 * `mcp.json` by hand. Names only — never a value or a token. Fixed `<dataDir>/mcp-header-names.json`;
 * construction performs no IO, reads validate strictly and writes are atomic (temp + rename, 0600).
 * Not a credential store, cross-process lock or DTO.
 */
export function createBackendMcpHeaderNameStore(options = {}) {
  try {
    if (!plain(options) || Reflect.ownKeys(options).some((key) => !["dataDir", "fileName"].includes(key))
      || typeof options.dataDir !== "string" || !isAbsolute(options.dataDir)) throw unavailable();
    const fileName = options.fileName ?? "mcp-header-names.json";
    if (typeof fileName !== "string" || !fileName || fileName.includes("/") || fileName.includes("\\")) throw unavailable();
    const path = join(resolve(options.dataDir), fileName);
    const validName = (name) => typeof name === "string" && name.length > 0 && name.length <= MAX_SERVER_NAME;
    const validHeader = (name) => typeof name === "string" && name.length > 0 && name.length <= 256 && HEADER_NAME.test(name);
    const readDocument = () => {
      let bytes;
      try { bytes = fs.readFileSync(path); }
      catch { return { version: 1, servers: {} }; } // A missing record is an empty one, not an error.
      try {
        if (bytes.length > MAX_BYTES) throw unavailable();
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        const value = JSON.parse(text);
        if (!plain(value) || value.version !== 1 || !plain(value.servers)) throw unavailable();
        const servers = {};
        for (const name of Object.keys(value.servers)) {
          const names = value.servers[name];
          if (!validName(name) || !Array.isArray(names) || names.length > MAX_NAMES || !names.every(validHeader)) throw unavailable();
          servers[name] = [...names];
        }
        return { version: 1, servers };
      } catch { throw unavailable(); }
    };
    const writeDocument = (document) => {
      const text = `${JSON.stringify(document)}\n`;
      if (Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
      const temp = `${path}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(resolve(options.dataDir), { recursive: true });
        fs.writeFileSync(temp, text, { mode: 0o600 });
        fs.renameSync(temp, path);
      } catch { try { fs.unlinkSync(temp); } catch { /* best effort */ } throw unavailable(); }
    };
    return Object.freeze({
      /** Names recorded for one server (a copy; never a live reference). */
      read(name) {
        try {
          if (!validName(name)) throw unavailable();
          const names = readDocument().servers[name];
          return Array.isArray(names) ? [...names] : [];
        } catch { throw unavailable(); }
      },
      /** Replaces the recorded names for one server; an empty list clears the entry. */
      record(name, names) {
        try {
          if (!validName(name) || !Array.isArray(names) || names.length > MAX_NAMES || !names.every(validHeader)) throw unavailable();
          const document = readDocument();
          if (names.length === 0) delete document.servers[name];
          else document.servers[name] = [...new Set(names)];
          writeDocument(document);
          return undefined;
        } catch { throw unavailable(); }
      },
      /** Drops the record for one server. */
      clear(name) { return this.record(name, []); },
    });
  } catch { throw unavailable(); }
}
