import { webAuthGate, refreshAuthCookie } from "./auth.mjs";
import { webUiPresentationResponse } from "../../shared/webui-presentation.mjs";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function compileRoutes(records) {
  const seen = new Set();
  return records.map(record => {
    if (seen.has(record.route) || !record.route.startsWith("/api/")) throw new Error("Invalid or duplicate API route");
    seen.add(record.route);
    const segments = record.route.split("/").slice(1), names = [];
    const pattern = segments.map(segment => {
      if (/^\[[A-Za-z_][A-Za-z0-9_]*\]$/.test(segment)) { names.push(segment.slice(1, -1)); return "([^/]+)"; }
      if (segment.includes("[")) throw new Error("Unsupported route segment");
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    return { ...record, segments, names, match: new RegExp(`^/${pattern}$`) };
  }).sort((a, b) => {
    for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
      const difference = Number(a.segments[i].startsWith("[")) - Number(b.segments[i].startsWith("["));
      if (difference) return difference;
      if (a.segments[i] !== b.segments[i]) return a.segments[i].localeCompare(b.segments[i], "en");
    }
    return b.segments.length - a.segments.length;
  });
}

export function createDispatcher(records, { gate = webAuthGate } = {}) {
  const routes = compileRoutes(records), loaded = new Map();
  return async (request, target) => {
    const url = new URL(request.url);
    // Raw target matters: WHATWG URL parsing has already replaced backslashes/dot segments.
    const parts = (target ?? url.pathname + url.search).split("?");
    let destination;
    if (/\\|\/\//.test(parts[0])) {
      // Next normalizes separators first and preserves its separate trailing-slash redirect.
      const normalized = parts[0].replace(/\\/g, "/").replace(/\/{2,}/g, "/") + (parts[1] ? `?${parts.slice(1).join("?")}` : "");
      const canonical = new URL(normalized, url);
      destination = canonical.pathname + canonical.search + canonical.hash;
    } else if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
      destination = url.pathname + url.search;
    }
    // Next redirects before its proxy/auth gate, without route Vary or refreshed cookies.
    if (destination !== undefined) {
      const body = new TextEncoder().encode(destination);
      return new Response(body, { status: 308, headers: { location: destination, refresh: `0;url=${destination}`, "content-length": String(body.byteLength) } });
    }
    const auth = gate(request);
    if (auth.response) return auth.response;
    const respond = response => {
      // Cache-key compatibility only; no Next code or RSC handling is part of the gateway.
      const vary = response.headers.get("vary");
      response.headers.set("vary", "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch" + (vary ? `, ${vary}` : ""));
      return refreshAuthCookie(response, auth);
    };
    // Display bootstrap is not an API/business route; retain the frozen P0 API inventory.
    if (url.pathname === "/webui-bootstrap.json") return respond(webUiPresentationResponse(request.method));
    if (!url.pathname.startsWith("/api/")) return respond(Response.json({ error: "Gateway serves API only during Phase1" }, { status: 404 }));
    const route = routes.find(record => record.match.test(url.pathname));
    if (!route) return respond(Response.json({ error: "Not Found" }, { status: 404 }));
    const match = route.match.exec(url.pathname), params = {};
    try { for (const [index, name] of route.names.entries()) params[name] = decodeURIComponent(match[index + 1]); }
    catch { return respond(Response.json({ error: "Bad Request" }, { status: 400 })); }
    const methods = new Set(route.methods);
    if (methods.has("GET")) methods.add("HEAD");
    methods.add("OPTIONS");
    if (!METHODS.includes(request.method) || !methods.has(request.method)) return respond(new Response(null, { status: 405 }));
    if (request.method === "OPTIONS" && !route.methods.includes("OPTIONS")) return respond(new Response(null, { status: 204, headers: { allow: [...methods].sort().join(", ") } }));
    let module = loaded.get(route.route);
    if (!module) { module = route.load(); loaded.set(route.route, module); }
    const handlers = await module, method = request.method === "HEAD" && !route.methods.includes("HEAD") ? "GET" : request.method;
    if (typeof handlers[method] !== "function") throw new Error("Gateway route manifest mismatch");
    return respond(await handlers[method](request, { params: Promise.resolve(params) }));
  };
}
