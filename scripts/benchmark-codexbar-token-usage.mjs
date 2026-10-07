/** Isolated SQLite microbenchmark. Usage: node scripts/benchmark-codexbar-token-usage.mjs [--baseline <git-ref>] */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "web/src/lib/codexbar/token-usage.ts");
const require = createRequire(join(root, "web/package.json"));
const { build } = require("esbuild");
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
if (baselineIndex >= 0 && (!baseline || baseline.startsWith("-"))) throw new Error("--baseline requires a git ref");
const temp = mkdtempSync(join(tmpdir(), "codexbar-token-benchmark-"));

async function measure(label, contents) {
  const bundle = join(temp, `${label}.mjs`);
  await build({ stdin: { contents, loader: "ts", sourcefile: "token-usage.ts", resolveDir: dirname(source) }, outfile: bundle,
    bundle: true, platform: "node", format: "esm", alias: { "@": join(root, "web/src"), "@backend-core": join(root, "backend/core") } });
  const samples = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    const code = `
      import assert from 'node:assert/strict';
      import {performance} from 'node:perf_hooks';
      import {DatabaseSync} from 'node:sqlite';
      import {join} from 'node:path';
      import * as store from ${JSON.stringify(pathToFileURL(bundle).href)};
      const n=300;
      const started=performance.now();
      for(let i=0;i<n;i++) assert.equal(store.recordAssistantTokenUsage('bench','a',{
        role:'assistant',provider:'openai-codex',model:'gpt',timestamp:i,stopReason:'stop',
        usage:{input:700,output:100,cacheRead:150,cacheWrite:50,totalTokens:1000}
      }),true);
      const writesMs=performance.now()-started;
      const at=new Date().toISOString();
      const reset=new Date(Date.now()+3600000).toISOString();
      const usage={available:true,reason:null,schema:null,generatedAt:at,subscriptionTotalMonthlyUsd:null,
        providers:[{id:'openai-codex',accountId:'a',plan:'Pro',usedPercent:10,updatedAt:at,resetsAt:reset,
          windows:['5h','week','month'].map(id=>({id,title:id,usedPercent:10,resetsAt:reset,windowMinutes:300})),credits:null}]};
      store.attachTokenUsage(usage);
      const pollStarted=performance.now();
      for(let i=0;i<n;i++) assert.equal(store.attachTokenUsage(usage).providers[0].tokenUsage.totalTokens,n*1000);
      const cachedPollsMs=performance.now()-pollStarted;
      const writer=new DatabaseSync(join(process.env.LEAFCODE_PI_DATA_DIR,"codexbar-token-usage.sqlite"));
      writer.exec("BEGIN IMMEDIATE");
      let lockedPollsMissingStats=0;
      const lockedStarted=performance.now();
      try {
        for(let i=0;i<3;i++) if(!store.attachTokenUsage(usage).providers[0].tokenUsage) lockedPollsMissingStats++;
      } finally { writer.exec("ROLLBACK"); writer.close(); }
      const lockedPollsMs=performance.now()-lockedStarted;
      store.closeTokenUsageStore?.();
      console.log(JSON.stringify({writesMs,cachedPollsMs,lockedPollsMs,lockedPollsMissingStats}));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, LEAFCODE_PI_DATA_DIR: join(temp, `${label}-${repetition}`) }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    samples.push(JSON.parse(child.stdout.trim()));
  }
  const median = (key) => samples.map((sample) => sample[key]).sort((a, b) => a - b)[1];
  return { writesMs: median("writesMs"), cachedPollsMs: median("cachedPollsMs"),
    lockedPollsMs: median("lockedPollsMs"), lockedPollsMissingStats: median("lockedPollsMissingStats") };
}

try {
  let previous;
  if (baseline) {
    const git = spawnSync("git", ["show", `${baseline}:web/src/lib/codexbar/token-usage.ts`], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.equal(git.status, 0, git.stderr);
    previous = await measure("baseline", git.stdout);
  }
  const current = await measure("current", readFileSync(source, "utf8"));
  console.log(JSON.stringify({ callsPerPhase: 300, lockedPollsPerPhase: 3, repetitions: 3, metric: "median wall time, isolated temp DB; not end-to-end UI latency",
    ...(previous ? { baseline: previous, speedup: { writes: previous.writesMs / current.writesMs, cachedPolls: previous.cachedPollsMs / current.cachedPollsMs, lockedPolls: previous.lockedPollsMs / current.lockedPollsMs } } : {}), current }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
