import { ServerResponse } from "node:http";

/**
 * Let `next start` compress route handler responses.
 *
 * Next copies a route handler's `Response` headers with `NodeNextResponse.appendHeader`, which stores
 * every header as an array (`["application/json"]`). The bundled `compression` middleware then calls
 * `compressible(res.getHeader("Content-Type"))`, which only accepts strings, so every API JSON body
 * (task lists of several hundred KB included) went to remote browsers uncompressed while pages and
 * static chunks were gzipped. A single-valued Content-Type is the same header either way; storing it
 * as a string makes the filter see it.
 */
const PATCHED = Symbol.for("leafcode-pi.http-content-type-string");

type PatchableResponse = {
  setHeader: (name: string, value: number | string | readonly string[]) => unknown;
  [PATCHED]?: boolean;
};

export function installContentTypeStringHeader(
  proto: PatchableResponse = ServerResponse.prototype as unknown as PatchableResponse,
): void {
  if (proto[PATCHED]) return;
  const original = proto.setHeader;
  proto.setHeader = function setHeader(this: unknown, name, value) {
    if (
      Array.isArray(value) &&
      value.length === 1 &&
      typeof value[0] === "string" &&
      typeof name === "string" &&
      name.toLowerCase() === "content-type"
    ) {
      return original.call(this, name, value[0]);
    }
    return original.call(this, name, value);
  };
  proto[PATCHED] = true;
}
