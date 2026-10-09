import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
it("keeps the public Provider SSE route and Next transport free of auth session/SDK/IO ownership", () => {
  const route = read("../app/api/providers/[id]/login/events/route.ts"), relay = read("./provider-auth-events-relay.ts");
  expect(route).toContain("relayProviderLoginEvents");
  for (const source of [route, relay]) expect(source).not.toMatch(/(?:node:fs|@earendil|subscribeProviderLogin|getActiveProviderLogin|ProviderLoginSession|(?:source|response|body|result)\.(?:arrayBuffer|text|json)\()/);
  expect(relay).toContain("bodyTimeout: 0"); expect(relay).toContain("highWaterMark: 0"); expect(relay).toContain('redirect: "error"');
  expect(relay).not.toMatch(/cancelProviderLogin|startProviderLogin|\.abortTask/);
});
it("keeps Backend OAuth recovery bounded and separate from reader lifetime", () => {
  const owner = read("../../../backend/runtime-src/lib/pi/auth-login.ts"), transport = read("../../../backend/runtime-src/json-business/provider-login-stream.ts");
  expect(owner).not.toContain("this.history.push"); expect(owner).toContain("PROVIDER_AUTH_STREAM_LIMIT"); expect(owner).toContain("measureBoundedEvent"); expect(owner).toContain("validateBoundedEvent"); expect(owner).toContain('this.history.delete("prompt")');
  expect(transport).toContain("GLOBAL_QUEUE_LIMIT"); expect(transport).toContain("PROVIDER_AUTH_BUFFER_LIMIT"); expect(transport).toContain("45000"); expect(transport).toContain("highWaterMark: 0"); expect(transport).not.toMatch(/cancelProviderLogin|session\.cancel|ensureRuntime|credential/);
});
