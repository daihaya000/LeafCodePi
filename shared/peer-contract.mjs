import { publicPeerCredential, publicPeerList, publicPeerUsage } from "./peer-wire.mjs";
import { publicAccountBody } from "./account-contract.mjs";
import { publicConfigurationMutation } from "./configuration-contract.mjs";
/** Public Peer wire protocol. Credential leases are allowed only on the Peer-authenticated resolve endpoint. */
export const PEER_ROUTES = Object.freeze({ "peer-auth/peers": ["GET", "POST", "PATCH", "DELETE"], "peer-auth/import": ["GET", "POST"], "peer-auth/list": ["GET"], "peer-auth/resolve": ["POST"], "peer-auth/usage": ["POST"] });
export const PEER_AUTHORIZATION_HEADER = "x-leafcode-business-peer-authorization";
export function peerTarget(path) { return Object.hasOwn(PEER_ROUTES, path) ? { route: path, params: {} } : null; }
export function peerFacing(path) { return ["peer-auth/list", "peer-auth/resolve", "peer-auth/usage"].includes(path); }
export function peerCommand(path, method) { return method !== "GET" && ["peer-auth/peers", "peer-auth/import"].includes(path); }
const record = value => value && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
function grant(input) {
  if (!record(input) || !["id", "label", "createdAt"].every(key => typeof input[key] === "string") || !strings(input.providers)) return null;
  return { id: input.id, label: input.label, createdAt: input.createdAt, providers: input.providers };
}
export function publicPeerBody(route, input, status) {
  if (!Object.hasOwn(PEER_ROUTES, route) || !record(input) || (input.error !== undefined && typeof input.error !== "string")) return null;
  let body = {};
  if (input.error !== undefined) body.error = input.error;
  if (status < 400 && !input.error) {
    if (route === "peer-auth/list") body = publicPeerList(input);
    else if (route === "peer-auth/usage") body = publicPeerUsage(input);
    else if (route === "peer-auth/resolve") {
      const credential = publicPeerCredential(input.credential); body = credential ? { credential } : null;
    } else if (route === "peer-auth/peers") {
      if (input.grant !== undefined) {
        const value = grant(input.grant); if (!value || status !== 201 || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(input.token)) return null;
        body = { grant: value, token: input.token }; // One-time creation token for authenticated management UI only.
      } else {
        if (typeof input.enabled !== "boolean" || typeof input.authRequired !== "boolean" || !Array.isArray(input.grants)) return null;
        const grants = input.grants.map(grant); if (grants.includes(null)) return null;
        body = { enabled: input.enabled, authRequired: input.authRequired, grants };
      }
    } else if (input.accounts !== undefined) body = publicAccountBody("accounts", input, status);
    else {
      if (!Array.isArray(input.peers)) return null;
      body.peers = [];
      for (const row of input.peers) {
        if (!record(row) || !["id", "label", "peerUrl"].every(key => typeof row[key] === "string") || !strings(row.providers) || typeof row.online !== "boolean") return null;
        let url; try { url = new URL(row.peerUrl); } catch { return null; }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== row.peerUrl) return null;
        body.peers.push({ id: row.id, label: row.label, peerUrl: row.peerUrl, providers: row.providers, online: row.online });
      }
    }
    if (!body) return null;
  }
  if (input.mutation !== undefined) { const mutation = publicConfigurationMutation(input.mutation); if (!mutation) return null; body.mutation = mutation; }
  return body;
}
