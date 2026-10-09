import { publicBackendHealthBody } from "@shared/backend-health-contract.mjs";
import { relayJsonBusiness } from "./json-business-relay";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "./webui-auth";
const STARTED_AT = Date.now();
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
/** Edge readiness stays independent of Backend availability; SDK metadata never has a local fallback. */
export async function relayBackendHealth(request: Request): Promise<Response> {
  const authorized = !webUiAuthRequired() || isWebUiRequestAuthorized(request);
  const response = await relayJsonBusiness(request, "health");
  if (!response.ok) return Response.json({ ok: true, engine: "pi", engineOk: false, version: null, modelCount: 0,
    backendAvailable: false, error: "Backend health unavailable", startedAt: STARTED_AT, platform: process.platform }, { headers });
  const health = publicBackendHealthBody(await response.json(), 200, authorized);
  if (!health || !("engine" in health)) return Response.json({ error: "Backend health unavailable" }, { status: 503, headers });
  return Response.json({ ...health, startedAt: STARTED_AT }, { headers });
}
