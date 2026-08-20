import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function localLeafcodePiTempDir(env = process.env) {
  const base = env.LOCALAPPDATA || tmpdir();
  return join(base, "leafcode-pi", "tmp");
}

export async function withLocalLeafcodeTempEnv(fn, deps = {}) {
  const env = deps.env ?? process.env;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const dir = deps.dir ?? localLeafcodePiTempDir(env);
  mkdir(dir, { recursive: true });
  const prevTemp = env.TEMP;
  const prevTmp = env.TMP;
  env.TEMP = dir;
  env.TMP = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevTemp === undefined) delete env.TEMP;
    else env.TEMP = prevTemp;
    if (prevTmp === undefined) delete env.TMP;
    else env.TMP = prevTmp;
  }
}
