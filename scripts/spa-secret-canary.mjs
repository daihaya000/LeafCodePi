import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// These are random dummy values, never credentials from the user's environment.
export function createSecretCanaries() {
  const entries = [], environment = {}, files = {};
  const add = (name, source) => {
    const value = `lcp_dummy_secret_${randomUUID()}`;
    entries.push({ name, source, value }); return value;
  };
  for (const name of ["VITE_SECRET", "VITE_API_KEY", "VITE_LEAFCODE_PI_WEBUI_TOKEN", "NEXT_PUBLIC_SECRET", "LEAFCODE_PI_WEBUI_TOKEN", "LEAFCODE_PI_BACKEND_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
    environment[name] = add(name, "process.env");
  }
  for (const [filename, suffix] of [[".env", "BASE"], [".env.local", "LOCAL"], [".env.production", "MODE"], [".env.production.local", "MODE_LOCAL"]]) {
    const name = `VITE_DOTENV_${suffix}_TOKEN`, precedence = "VITE_DOTENV_PRECEDENCE_TOKEN";
    files[filename] = `${name}=${add(name, filename)}\n${precedence}=${add(precedence, filename)}\n`;
  }
  return { entries, environment, files };
}

export async function withCanaryEnvironment(canaries, work) {
  const previous = { ...process.env };
  const system = /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS)$/;
  try {
    for (const name of Object.keys(process.env)) if (!system.test(name)) delete process.env[name];
    Object.assign(process.env, canaries.environment, { NODE_ENV: "production" });
    return await work();
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  }
}

export function assertNoCanary(value, entries, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value) ?? "");
  for (const entry of entries) {
    const raw = Buffer.from(entry.value);
    const forms = new Set([entry.value, encodeURIComponent(entry.value), raw.toString("base64"), raw.toString("base64url"), raw.toString("hex"), [...raw].map(byte => `\\u${byte.toString(16).padStart(4, "0")}`).join(""), [...raw].map(byte => `\\x${byte.toString(16).padStart(2, "0")}`).join("")]);
    for (const form of forms) if (bytes.includes(Buffer.from(form))) {
      // Failure output identifies the input/sink but does not print its value.
      assert.fail(`SPA secret canary leaked: ${entry.name} (${entry.source}) into ${label}`);
    }
  }
}

export async function scanCanaryArtifacts(root, entries) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(directory, entry.name);
      assertNoCanary(name, entries, "artifact filename");
      assert.equal(entry.isSymbolicLink(), false, `Artifact symlink is not audited: ${name}`);
      if (entry.isDirectory()) await visit(path, name + "/");
      else {
        assertNoCanary(await readFile(path), entries, `artifact ${name}`);
        files.push(name);
      }
    }
  }
  await visit(root);
  assert.ok(files.includes("index.html"), "Artifact scan must include the generated entry HTML");
  assert.ok(files.some(name => name.endsWith(".js")), "Artifact scan must include a browser bundle");
  return { files, maps: files.filter(name => name.endsWith(".map")).length };
}

export function auditCanaryResponses(context, entries, onError) {
  const pending = [];
  let completed = 0;
  context.on("response", response => {
    try { assertNoCanary(response.headers(), entries, "browser response headers"); } catch (error) { onError(error.message); }
  });
  context.on("requestfinished", request => {
    if (request.resourceType() === "eventsource" || new URL(request.url()).pathname.endsWith("/events")) return;
    // The response event precedes body completion and reload cancellation.
    // Only requestfinished gives us a finite non-stream body to inspect.
    pending.push(request.response().then(async response => {
      assert.ok(response, "Finished request must have a response");
      if (response.headers()["content-type"]?.includes("text/event-stream")) return;
      assertNoCanary(await response.body(), entries, "browser response body"); completed++;
    }).catch(error => onError(`Browser response audit failed: ${error.message}`)));
  });
  return async () => {
    while (pending.length) await Promise.all(pending.splice(0));
    return completed;
  };
}

// A test-only virtual module forces both whole-object and named env accesses to
// remain reachable. A normal app might tree-shake unused leaked env variables.
export function canaryProbePlugin(entries) {
  const names = [...new Set(entries.map(entry => entry.name))], id = "\0leafcode-spa-canary-probe";
  return {
    name: "spa-test-only-env-probe",
    resolveId(source) { if (source === "leafcode-spa-canary-probe") return id; },
    load(source) {
      if (source !== id) return;
      const named = names.map(name => `${JSON.stringify(name)}:import.meta.env.${name}`).join(",");
      const node = names.map(name => `${JSON.stringify(name)}:process.env.${name}`).join(",");
      return `globalThis.__leafcodeCanaryProbe = { env: import.meta.env, named: {${named}}, node: {${node}}, nodeMode: process.env.NODE_ENV };`;
    },
    transform(code, source) {
      if (source.replaceAll("\\", "/").endsWith("/src/spa/main.tsx")) return `import 'leafcode-spa-canary-probe';\n${code}`;
    },
  };
}
