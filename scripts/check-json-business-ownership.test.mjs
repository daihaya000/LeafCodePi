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
    assert.deepEqual(source.statements.filter(ts.isImportDeclaration).map(n => n.moduleSpecifier.text).sort(), ["@/lib/json-business-relay", "next/server"].sort());
    for (const method of methods) {
      const handler = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === method);
      assert.equal(handler?.body?.statements.length, 1);
      const statement = handler.body.statements[0];
      assert.ok(ts.isReturnStatement(statement) && ts.isCallExpression(statement.expression));
      assert.equal(statement.expression.expression.getText(source), "relayJsonBusiness");
      assert.equal(statement.expression.arguments[1].text, route);
    }
    assert.doesNotMatch(readFileSync(join(root, "backend/runtime-src/json-business/handlers", route, "route.ts"), "utf8"), /from ["']next\//);
  });
}
test("wire contract is pure and projection removes private owner fields/headers", () => {
  assert.doesNotMatch(readFileSync(join(root, "shared/json-business-contract.mjs"), "utf8"), /node:|next\/|process\.|readFile|writeFile|@earendil/);
  const publicResult = publicJsonBusinessResult("git/init", { status: 200, body: { ok: true, directory: "repo", token: "private" }, headers: { "set-cookie": "private", etag: "value" } });
  assert.deepEqual(publicResult, { status: 200, body: { ok: true, directory: "repo" }, headers: { etag: "value" } });
  assert.equal(publicJsonBusinessResult("git/init", { status: 200, body: { token: "private" } }), null);
  assert.equal(publicJsonBusinessResult("git/log", { status: 304, body: {}, headers: {} }), null);
});
