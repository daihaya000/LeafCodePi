import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_BUSINESS_ROUTES, publicJsonBusinessResult } from "../shared/json-business-contract.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ts = createRequire(join(root, "backend/package.json"))("typescript");
for (const [route, methods] of Object.entries(JSON_BUSINESS_ROUTES)) {
  test(`Next ${route} is transport only`, () => {
    const path = join(root, "web/src/app/api", route, "route.ts"), source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    assert.deepEqual(source.statements.filter(ts.isImportDeclaration).map(n => n.moduleSpecifier.text).sort(), ["@/lib/json-business-relay", "next/server", ...(route === "browse/dirs" ? ["@/lib/host-folder-relay"] : [])].sort());
    for (const method of methods) {
      const handler = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === method);
      assert.equal(handler?.body?.statements.length, 1);
      const statement = handler.body.statements[0];
      assert.ok(ts.isReturnStatement(statement) && ts.isCallExpression(statement.expression));
      assert.equal(statement.expression.expression.getText(source), "relayJsonBusiness");
      const parameters = [...route.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
      if (parameters.length) {
        const argument = statement.expression.arguments[1];
        assert.ok(ts.isTemplateExpression(argument));
        const literals = route.split(/\[[^\]]+\]/);
        assert.equal(argument.head.text, literals[0]);
        assert.equal(argument.templateSpans.length, parameters.length);
        parameters.forEach((parameter, index) => {
          assert.equal(argument.templateSpans[index].literal.text, literals[index + 1]);
          assert.equal(argument.templateSpans[index].expression.getText(source), `encodeURIComponent((await context.params).${parameter})`);
        });
      } else assert.equal(statement.expression.arguments[1].text, route);
    }
    if (route === "browse/dirs") {
      const handler = source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==="POST");
      assert.equal(handler.body.statements.length,1);
      assert.equal(handler.body.statements[0].expression.expression.getText(source),"relayHostFolderSelection");
    }
    if (route === "mcp" || route.startsWith("mcp/")) {
      const owner = readFileSync(join(root, "backend/src/mcp-json-business.mjs"), "utf8"), server = readFileSync(join(root, "backend/src/server.mjs"), "utf8");
      assert.doesNotMatch(owner, /from ["']next\//);
      assert.match(owner, /assertConfigurationOwner\(\)/);
      assert.match(server, /mcpBusinessTarget\(businessPath\) \? mcpBusinessRequest : jsonBusinessRequestAction/);
    } else assert.doesNotMatch(readFileSync(join(root, "backend/runtime-src/json-business/handlers", route, "route.ts"), "utf8"), /from ["']next\//);
  });
}
test("Next login SSE is an opaque subscriber relay, not a local SDK/session owner", () => {
  const path = join(root, "web/src/app/api/providers/[id]/login/events/route.ts"), source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  assert.deepEqual(source.statements.filter(ts.isImportDeclaration).map(n => n.moduleSpecifier.text).sort(), ["@/lib/provider-auth-events-relay", "next/server"].sort());
  const handler = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "GET");
  assert.equal(handler.body.statements.length, 1); const statement = handler.body.statements[0];
  assert.ok(ts.isReturnStatement(statement) && ts.isCallExpression(statement.expression));
  assert.equal(statement.expression.expression.getText(source), "relayProviderLoginEvents");
  assert.equal(statement.expression.arguments[1].getText(source), "encodeURIComponent((await context.params).id)");
});
test("wire contract is pure and projection removes private owner fields/headers", () => {
  for (const name of ["json-business-contract.mjs", "definition-contract.mjs", "provider-contract.mjs", "provider-auth-contract.mjs"]) assert.doesNotMatch(readFileSync(join(root, "shared", name), "utf8"), /node:|next\/|process\.|readFile|writeFile|@earendil/);
  const publicResult = publicJsonBusinessResult("git/init", { status: 200, body: { ok: true, directory: "repo", token: "private" }, headers: { "set-cookie": "private", etag: "value" } });
  assert.deepEqual(publicResult, { status: 200, body: { ok: true, directory: "repo" }, headers: { etag: "value" } });
  assert.equal(publicJsonBusinessResult("git/init", { status: 200, body: { token: "private" } }), null);
  assert.equal(publicJsonBusinessResult("git/log", { status: 304, body: {}, headers: {} }), null);
});
