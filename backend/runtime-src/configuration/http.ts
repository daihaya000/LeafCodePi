import { isWebUiRequestAuthorized as verifyWebUiRequest } from "../lib/webui-auth";

export type ConfigurationRequest = Request & { nextUrl: URL };
export const ConfigurationResponse = Response;
export type ConfigurationResponse = Response;
const access = new WeakMap<Request, boolean>();
/** Only the authenticated internal transport installs this context. Never copied from public headers. */
export function configurationRequest(request: Request, authorized: boolean): ConfigurationRequest {
  Object.defineProperty(request, "nextUrl", { value: new URL(request.url) });
  access.set(request, authorized);
  return request as ConfigurationRequest;
}
export function isConfigurationRequestAuthorized(request: Request): boolean {
  return access.has(request) ? access.get(request) === true : verifyWebUiRequest(request);
}
