import { JsonBodyReadError } from "./json-body.mjs";
/** Raw, bounded upload; JSON and multipart are validated by the owner after transport admission. */
export function readConfigurationBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      request.off("data", onData); request.off("end", onEnd); request.off("aborted", onError);
      if (error) { chunks.length = 0; reject(error); }
      else { const body = Buffer.concat(chunks, size); chunks.length = 0; resolve(body); }
    };
    const overflow = () => { request.pause(); finish(new JsonBodyReadError("too-large")); };
    const onData = (chunk) => { size += chunk.length; if (size > limit) overflow(); else chunks.push(chunk); };
    const onEnd = () => finish();
    const onError = () => finish(new JsonBodyReadError("incomplete"));
    const onClose = () => { onError(); request.off("error", onError); };
    request.on("data", onData); request.once("end", onEnd); request.once("aborted", onError);
    request.on("error", onError); request.once("close", onClose);
    if (request.destroyed || request.aborted) { onError(); return; }
    const declared = request.headers["content-length"];
    if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > limit) overflow();
  });
}
