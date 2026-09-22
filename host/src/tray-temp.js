import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function localLeafcodePiTempDir(env = process.env) {
  const base = env.LOCALAPPDATA || tmpdir();
  return join(base, "leafcode-pi", "tmp");
}

export async function withLocalLeafcodeTempEnv(fn, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const dir = deps.dir ?? localLeafcodePiTempDir(env);
  mkdir(dir, { recursive: true });
  const prevTemp = env.TEMP;
  const prevTmp = env.TMP;
  const prevTmpDir = env.TMPDIR;
  env.TEMP = dir;
  env.TMP = dir;
  if (platform !== "win32") env.TMPDIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevTemp === undefined) delete env.TEMP;
    else env.TEMP = prevTemp;
    if (prevTmp === undefined) delete env.TMP;
    else env.TMP = prevTmp;
    if (platform !== "win32") {
      if (prevTmpDir === undefined) delete env.TMPDIR;
      else env.TMPDIR = prevTmpDir;
    }
  }
}
