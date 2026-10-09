import assert from "node:assert/strict"; import test from "node:test";
import { MCP_BUSINESS_ROUTES, mcpBusinessTarget, mcpBusinessBodyLimit, publicMcpBusinessBody, validMcpBusinessName } from "./mcp-business-contract.mjs";
test("MCP six operations decode selectors once, reject names and retain auth/header byte budgets", () => {
  assert.equal(Object.values(MCP_BUSINESS_ROUTES).flat().length, 6); assert.equal(mcpBusinessTarget("mcp/x%252Fy/auth").params.name, "x%2Fy"); assert.equal(mcpBusinessTarget("mcp/%ZZ"), null);
  for (const name of ["", "..", "a/b", "a\\b", "bad\n", "x".repeat(257)]) assert.equal(validMcpBusinessName(name), false);
  assert.equal(mcpBusinessBodyLimit("mcp/name/auth", "POST"), 2 * 1024 * 1024); assert.equal(mcpBusinessBodyLimit("mcp", "POST"), 65536); assert.equal(mcpBusinessBodyLimit("mcp/name/auth", "DELETE"), 4096);
});
test("auth/static list/reload projection strips secrets and paths while preserving OAuth state/PKCE", () => {
  const auth={name:"remote",authType:"bearer",credentialConfigured:true,credentialSource:"config",credentialStatus:"present",url:"https://user:PRIVATE@example.invalid/mcp?token=PRIVATE",token:"PRIVATE",configPath:"PRIVATE"};
  const reload={reloaded:1,deferred:2,failed:1,errors:["PRIVATE"]},operation={id:"11111111-0123-4321-abcd-eeeeeeeeeeee",execution:"unknown",token:"PRIVATE"};
  const projected=publicMcpBusinessBody("mcp/[name]/auth",{ok:true,auth,reload,operation},200,"POST");assert.ok(projected);assert.ok(!JSON.stringify(projected).includes("PRIVATE"));assert.equal(projected.reload.failed,1);assert.equal(projected.auth.url,"https://example.invalid/mcp");
  const oauth=publicMcpBusinessBody("mcp/[name]/auth",{ok:true,name:"remote",status:"pending",authorizationUrl:"https://auth.invalid?state=opaque&code_challenge=pkce"},200,"POST");assert.match(oauth.authorizationUrl,/state=opaque/);assert.match(oauth.authorizationUrl,/code_challenge=pkce/);
  assert.equal(publicMcpBusinessBody("mcp/[name]/auth",{ok:true,name:"remote",status:"pending",authorizationUrl:"https://auth.invalid?code_verifier=PRIVATE"},200,"POST"),null);
});
