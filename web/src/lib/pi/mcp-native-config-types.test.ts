import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("Backend native MCP callback public SDK contract", () => {
  it("typechecks the prepared synchronous callback against installed Backend MCP options", () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-native-mcp-types-"));
    try {
      const modulePath = fileURLToPath(new URL("../../../../backend/core/mcp-native-config-loader.mjs", import.meta.url));
      const extensionsPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-extensions.mjs", import.meta.url));
      const compilerOptions: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, noEmit: true, types: [] };
      // Resolve the public ESM/types export in Backend scope; this package has no CommonJS main.
      const sdk = ts.resolveModuleName("@earendil-works/pi-coding-agent", modulePath, compilerOptions, ts.sys,
        undefined, undefined, ts.ModuleKind.ESNext).resolvedModule;
      expect(sdk).toBeDefined();
      const probe = join(root, "probe.mts");
      writeFileSync(probe, `import { prepareBackendMcpConfigLoader } from ${JSON.stringify(modulePath)};
import { prepareBackendMcpExtensions, type BackendMcpOwnerServices } from ${JSON.stringify(extensionsPath)};
import type { DefaultResourceLoader, ExtensionContext, LoadedMcpConfig, McpExtensionOptions, McpServerEntry } from "@earendil-works/pi-coding-agent";
declare const credentials: NonNullable<McpExtensionOptions["credentials"]>;
const services: BackendMcpOwnerServices = { credentials, openUrl: (url) => {}, updateConfig: (entry, patch) => {} };
const extensions = await prepareBackendMcpExtensions({ agentDir: "owner", bundledConfigPath: "bundle", mcp: services });
if (extensions.ok) {
  const factories: ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"] = extensions.factories;
} else {
  const unavailableFactories: null = extensions.factories;
}
// @ts-expect-error Owner credentials/browser/writer are mandatory.
const missing: BackendMcpOwnerServices = {};
const prepared = await prepareBackendMcpConfigLoader({ agentDir: "owner", bundledConfigPath: "bundle", urlVariables: { URL: "value" } });
if (prepared.ok) {
  const options: McpExtensionOptions = { loadConfig: prepared.loadConfig };
  const loaded: LoadedMcpConfig = options.loadConfig!({} as ExtensionContext);
  const entries: McpServerEntry[] = loaded.servers;
  const revision: string | null = prepared.sourceSha256;
  const bundledRevision: string = prepared.bundledSha256;
} else {
  const unavailable: null = prepared.loadConfig;
  const issue: string | undefined = prepared.issues[0]?.code;
}
`, "utf8");
      const program = ts.createProgram([probe], { ...compilerOptions,
        baseUrl: root, paths: { "@earendil-works/pi-coding-agent": [sdk!.resolvedFileName] } });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      expect(diagnostics.map((value) => ts.flattenDiagnosticMessageText(value.messageText, "\n"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
