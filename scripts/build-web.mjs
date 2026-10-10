import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpaGeneration, resolveSpaMirrorRoot } from "./spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/** Publish a complete sealed SPA/gateway pair, never restart Host/Backend/SDK. */
export function buildWebOptions(args = [], env = process.env) {
  const options = { checkout: ROOT, mirrorRoot: resolveSpaMirrorRoot(env, join(ROOT, "web")), offline: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--offline") options.offline = true;
    else if (arg === "--mirror") {
      const value = args[++index]; if (!value || value.startsWith("--")) throw Error("--mirror requires an explicit directory");
      options.mirrorRoot = resolve(value);
    } else throw Error(`Unsupported production build option: ${arg}`);
  }
  return options;
}
export async function buildWeb({ args = [], env = process.env, build = buildSpaGeneration, log = () => {} } = {}) {
  const generation = await build({ ...buildWebOptions(args, env), log });
  return { type: "spa_generation_built", id: generation.id, directory: generation.directory };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildWeb({ args: process.argv.slice(2), log: text => process.stderr.write(text) }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
