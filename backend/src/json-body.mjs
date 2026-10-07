/** Attachments are already size-checked by the WebUI; the transport also bounds raw bytes. */
export const BACKEND_PROMPT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/** Transport failures must not be treated as an optional/empty action body. */
export class JsonBodyReadError extends Error {
  constructor(reason) {
    super(reason === "too-large" ? "Request body too large" : "Request body interrupted");
    this.name = "JsonBodyReadError";
    this.reason = reason;
  }
}

/** Empty or broken JSON resolves with ok=false; overflow or disconnect rejects before owner work. */
export function readJsonBody(request, limit = BACKEND_PROMPT_BODY_LIMIT_BYTES) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid JSON body limit");
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      // Release buffered bytes immediately, including on early rejection. Keep the
      // error listener until close: Node emits aborted -> error -> close on reset.
      chunks.length = 0;
      if (error) reject(error);
      else resolve(result);
    };
    const tooLarge = () => {
      // Do not destroy the socket: the outer handler must flush its 413 first.
      // Stop consuming bytes; that response closes the connection after flushing.
      request.pause();
      finish(undefined, new JsonBodyReadError("too-large"));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) { tooLarge(); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (size === 0) { finish({ ok: false, reason: "empty" }); return; }
      let result;
      try { result = { ok: true, value: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) }; }
      catch { result = { ok: false, reason: "invalid" }; }
      finish(result);
    };
    const onAborted = () => finish(undefined, new JsonBodyReadError("incomplete"));
    const onError = () => finish(undefined, new JsonBodyReadError("incomplete"));
    const onClose = () => {
      onAborted();
      request.off("close", onClose);
      request.off("error", onError);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.on("error", onError);
    request.once("close", onClose);
    if (request.destroyed || request.aborted) {
      // destroy() can queue its error/close events; keep observing them until close.
      onAborted();
      return;
    }
    // Reject before allocating body buffers, even if the sender never sends a byte.
    const declaredSize = request.headers?.["content-length"];
    if (typeof declaredSize === "string" && /^\d+$/.test(declaredSize) && Number(declaredSize) > limit) tooLarge();
  });
}
