import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIGURATION_ROUTES } from "../shared/configuration-contract.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ts = createRequire(join(root, "backend", "package.json"))("typescript");

for (const [route, methods] of Object.entries(CONFIGURATION_ROUTES)) {
  test(`Next ${route} has only ingress relay operations`, () => {
    const path = join(root, "web/src/app/api", route, "route.ts");
    const text = readFileSync(path, "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
    assert.deepEqual([...new Set(imports)].sort(), (route === "profile"
      ? ["@/lib/configuration-relay", "@/lib/task-file-stream-relay"]
      : ["@/lib/configuration-relay"]).sort());
    for (const method of methods) {
      const handler = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === method);
      assert.ok(handler, `${route} ${method} missing`);
      const body = handler.body.getText(source);
      assert.ok(body.includes("relayConfiguration("), `${route} ${method} must not execute a local handler`);
      assert.doesNotMatch(body, /(?:setSetting|writeFile|mkdir|importProfile|resetProfile|ModelRuntime|setCompactionEnabled)\(/);
    }
  });
}
test("configuration contracts remain pure and Backend handlers do not depend on Next", () => {
  const contract = readFileSync(join(root, "shared/configuration-contract.mjs"), "utf8");
  assert.doesNotMatch(contract, /(?:node:|next\/|@earendil|process\.|writeFile|readFile)/);
  for (const route of Object.keys(CONFIGURATION_ROUTES)) {
    const handler = readFileSync(join(root, "backend/runtime-src/configuration/handlers", route, "route.ts"), "utf8");
    assert.doesNotMatch(handler, /from ["']next\//);
  }
});
