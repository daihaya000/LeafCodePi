import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { taskFileTarget, TASK_FILE_ROUTES } from "./task-file-stream-contract.mjs";
const ts = createRequire(new URL("../backend/package.json", import.meta.url))("typescript");
test("file routes decode one bounded ID and have no file access vocabulary", () => {
 assert.deepEqual(taskFileTarget("tasks/bot%3Ax/media"), { route:"tasks/[id]/media",id:"bot:x",kind:"media" });
 for (const route of ["tasks/a%2Fb/media","tasks/a%5Cb/media","tasks/../media","tasks/%00/media","tasks/%ZZ/image","tasks/"+ "x".repeat(513)+"/image","tasks/x/not-file"]) assert.equal(taskFileTarget(route),null);
});
for(const [route, methods] of Object.entries(TASK_FILE_ROUTES)) test("Next "+route+" is a single opaque streaming relay",()=>{
 const path=new URL("../web/src/app/api/"+route+"/route.ts",import.meta.url),source=ts.createSourceFile(path.href,readFileSync(path,"utf8"),ts.ScriptTarget.Latest,true);
 assert.deepEqual(source.statements.filter(ts.isImportDeclaration).map(x=>x.moduleSpecifier.text).sort(),["@/lib/task-file-stream-relay","next/server"]);
 for(const method of methods){const fn=source.statements.find(x=>ts.isFunctionDeclaration(x)&&x.name.text===method);assert.equal(fn.body.statements.length,1);assert.equal(fn.body.statements[0].expression.expression.getText(source),"relayTaskFileStream");assert.equal(fn.body.statements[0].expression.arguments[1].templateSpans[0].expression.getText(source),"encodeURIComponent((await context.params).id)");}
});
test("Next never reads or decodes whole response bodies",()=>{
 const source=readFileSync(new URL("../web/src/lib/task-file-stream-relay.ts",import.meta.url),"utf8");
 assert.doesNotMatch(source,/\.arrayBuffer\(|\.text\(|(?:source|response|request)\.json\(|Buffer\.from|readFile|local-media|local-image|harness/);
 assert.match(source,/highWaterMark: 0/);
});
