import assert from "node:assert/strict";
import { test } from "node:test";
import { inheritedEnv, inheritedEnvEntries, isInheritedEnvName } from "./mcp-native-inherited-env.mjs";

const POSIX = ["PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SHELL", "TERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_PATH", "HTTP_PROXY", "https_proxy", "NO_PROXY"];
const WINDOWS = ["Path", "PATHEXT", "SystemRoot", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE",
  "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "CommonProgramFiles(x86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
const TOOLING = ["npm_config_registry", "NPM_CONFIG_CACHE", "npm_config_prefix", "npm_config_userconfig",
  "npm_config_https_proxy", "PNPM_HOME", "YARN_CACHE_FOLDER"];
// Members of the same families that carry a credential, as npm, pnpm and yarn actually spell them.
const CREDENTIALS = ["npm_config__authToken", "NPM_CONFIG_//registry.npmjs.org/:_authToken", "npm_config__auth",
  "npm_config_//npm.pkg.github.com/:_password", "NPM_CONFIG_KEY", "YARN_NPM_AUTH_TOKEN", "YARN_NPM_AUTH_IDENT",
  "PNPM_AUTH_TOKEN"];
const UNRELATED = ["SECRET_TOKEN", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "NODE_AUTH_TOKEN",
  "HOMEBREW_GITHUB_API_TOKEN", "PATH_EXTRA", "LEAFCODE_PI_WEBUI_TOKEN"];

test("well-known runtime names are inherited whatever their spelling", () => {
  for (const name of [...POSIX, ...WINDOWS]) assert.equal(isInheritedEnvName(name), true, `${name} must be inherited`);
});

test("tooling families are inherited, but their credentials are not", () => {
  for (const name of TOOLING) assert.equal(isInheritedEnvName(name), true, `${name} must be inherited`);
  for (const name of CREDENTIALS) assert.equal(isInheritedEnvName(name), false, `${name} must not be inherited`);
});

test("other variables never are, including names that only start like an allowed one", () => {
  for (const name of UNRELATED) assert.equal(isInheritedEnvName(name), false, `${name} must not be inherited`);
});

test("inheritedEnv keeps the original spelling and values and leaves its source alone", () => {
  const source = { Path: "C:\\bin", HOME: "/home/u", SECRET_TOKEN: "s", npm_config_registry: "https://r/", npm_config__authToken: "t" };
  const copy = structuredClone(source);
  assert.deepEqual(inheritedEnv(source), { Path: "C:\\bin", HOME: "/home/u", npm_config_registry: "https://r/" });
  assert.deepEqual(source, copy);
});

test("inheritedEnvEntries filters the transport's normalized map and keeps its shape", () => {
  const entries = new Map([
    ["path", ["Path", "C:\\bin"]],
    ["secret_token", ["SECRET_TOKEN", "s"]],
    ["npm_config__authtoken", ["npm_config__authToken", "t"]],
    ["npm_config_cache", ["npm_config_cache", "c"]],
  ]);
  assert.deepEqual([...inheritedEnvEntries(entries)], [["path", ["Path", "C:\\bin"]], ["npm_config_cache", ["npm_config_cache", "c"]]]);
  assert.equal(entries.size, 4);
});

test("the answer does not depend on the host platform", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const source = Object.fromEntries([...POSIX, ...WINDOWS, ...TOOLING, ...CREDENTIALS, ...UNRELATED].map((name) => [name, "v"]));
  try {
    const kept = ["linux", "darwin", "win32"].map((platform) => {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      return Object.keys(inheritedEnv(source)).sort();
    });
    assert.deepEqual(kept[1], kept[0]);
    assert.deepEqual(kept[2], kept[0]);
    assert.deepEqual(kept[0], [...POSIX, ...WINDOWS, ...TOOLING].sort());
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
