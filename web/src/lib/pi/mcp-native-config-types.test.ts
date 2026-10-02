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
      const credentialsPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-credentials.mjs", import.meta.url));
      const credentialOwnerPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-credential-owner.mjs", import.meta.url));
      const privateStoragePath = fileURLToPath(new URL("../../../../backend/core/mcp-private-storage.mjs", import.meta.url));
      const oauthStatusPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-oauth-status.mjs", import.meta.url));
      const authorityPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-credential-authority.mjs", import.meta.url));
      const generationLeasePath = fileURLToPath(new URL("../../../../backend/core/mcp-native-generation-lease.mjs", import.meta.url));
      const writeCoordinatorPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-write-coordinator.mjs", import.meta.url));
      const configUpdaterPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-config-updater.mjs", import.meta.url));
      const configFileWriterPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-config-file-writer.mjs", import.meta.url));
      const configRevisionPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-config-revision.mjs", import.meta.url));
      const configOwnerPath = fileURLToPath(new URL("../../../../backend/core/mcp-native-config-owner.mjs", import.meta.url));
      const compilerOptions: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, noEmit: true, types: [] };
      // Resolve the public ESM/types export in Backend scope; this package has no CommonJS main.
      const sdk = ts.resolveModuleName("@earendil-works/pi-coding-agent", modulePath, compilerOptions, ts.sys,
        undefined, undefined, ts.ModuleKind.ESNext).resolvedModule;
      expect(sdk).toBeDefined();
      const probe = join(root, "probe.mts");
      writeFileSync(probe, `import { prepareBackendMcpConfigLoader } from ${JSON.stringify(modulePath)};
import { prepareBackendMcpExtensions, type BackendMcpOwnerServices } from ${JSON.stringify(extensionsPath)};
import { createBackendMcpCredentials, type BackendMcpOAuthState } from ${JSON.stringify(credentialsPath)};
import { createBackendMcpCredentialOwner } from ${JSON.stringify(credentialOwnerPath)};
import { createBackendMcpPrivateStorageCheck, createBackendMcpConfigStorageCheck, assertMcpStoragePermissions } from ${JSON.stringify(privateStoragePath)};
import { createBackendMcpOAuthStatusReader, type BackendMcpOAuthStatus } from ${JSON.stringify(oauthStatusPath)};
import { createBackendMcpCredentialAuthority } from ${JSON.stringify(authorityPath)};
import { createBackendMcpGenerationOwner } from ${JSON.stringify(generationLeasePath)};
import { createBackendMcpWriteCoordinator } from ${JSON.stringify(writeCoordinatorPath)};
import { createBackendMcpConfigUpdater } from ${JSON.stringify(configUpdaterPath)};
import { createBackendMcpConfigFileWriter } from ${JSON.stringify(configFileWriterPath)};
import { createBackendMcpConfigRevisionCheck } from ${JSON.stringify(configRevisionPath)};
import { createBackendMcpConfigOwner } from ${JSON.stringify(configOwnerPath)};
import type { DefaultResourceLoader, ExtensionContext, LoadedMcpConfig, McpExtensionOptions, McpServerEntry } from "@earendil-works/pi-coding-agent";
const checkStorage = createBackendMcpPrivateStorageCheck({ agentDir: "owner" });
const owner = createBackendMcpCredentialOwner({ agentDir: "owner", assertOwner: (identity) => {}, assertPrivateStorage: checkStorage });
assertMcpStoragePermissions({ platform: "linux", currentUid: 1000, fsType: 0xef53, directory: { uid: 1000, mode: 0o700 }, file: null });
const credentials = createBackendMcpCredentials(owner);
const readOAuthStatus = createBackendMcpOAuthStatusReader({ owner, now: () => 1000 });
const oauthStatus: BackendMcpOAuthStatus = readOAuthStatus("fixture", "https://example.invalid");
const publicOAuthType: "oauth" = oauthStatus.authType;
const publicExpiry: "present" | "missing" | "expired" | "unknown" = oauthStatus.credentialStatus;
// @ts-expect-error Explicit owner is mandatory; no ambient store fallback.
createBackendMcpOAuthStatusReader({ now: () => 1000 });
// @ts-expect-error Read-only status never returns access tokens.
oauthStatus.tokens;
// @ts-expect-error Storage permission attestation is mandatory.
createBackendMcpCredentialOwner({ agentDir: "owner", assertOwner: (identity) => {} });
const serverStore: ReturnType<NonNullable<McpExtensionOptions["credentials"]>["forServer"]> = credentials.forServer("fixture", "https://example.invalid");
const nativeState: BackendMcpOAuthState = { serverUrl: "https://example.invalid", tokens: { access_token: "fixture", token_type: "Bearer" } };
serverStore.save(nativeState);
const storedTokens: ReturnType<NonNullable<McpExtensionOptions["credentials"]>["tokens"]> = credentials.tokens("fixture", "https://example.invalid");
// @ts-expect-error Structural boundary is intentionally NOT the SDK's unexported concrete class.
const concreteCredentials: NonNullable<McpExtensionOptions["credentials"]> = credentials;
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
  const generationOwner = createBackendMcpGenerationOwner({ assertProcessOwner: () => {} });
  const generationLease = generationOwner.beginGeneration();
  const coordinator = createBackendMcpWriteCoordinator({ assertProcessOwner: () => {} });
  const writerLease = coordinator.beginGeneration();
  const authority = createBackendMcpCredentialAuthority({ agentDir: "owner", bundledConfigPath: "bundle", prepared, assertRuntimeOwner: writerLease.assertOwner });
  const writerResult: Promise<number> = coordinator.runWrite((scope) => { scope.assertOwner(); return 42; });
  const synchronousUpdater: NonNullable<McpExtensionOptions["updateConfig"]> = (entry, patch) => {
    coordinator.runWriteSync((scope) => { scope.assertOwner(); return undefined; });
  };
  const synchronousServices: BackendMcpOwnerServices = { ...services, updateConfig: synchronousUpdater };
  const revisionOptions = { agentDir: "owner", bundledConfigPath: "bundle", expectedSha256: prepared.sourceSha256, expectedBundledSha256: prepared.bundledSha256, assertRuntimeOwner: writerLease.assertOwner };
  const checkRevision: () => void = createBackendMcpConfigRevisionCheck(revisionOptions);
  // @ts-expect-error Explicit fixed-source revisions and runtime authority are mandatory.
  createBackendMcpConfigRevisionCheck({ agentDir: "owner", bundledConfigPath: "bundle" });
  const updaterOptions = { agentDir: "owner", bundledConfigPath: "bundle", prepared, coordinator, assertSnapshotOwner: checkRevision };
  const checkConfigStorage = createBackendMcpConfigStorageCheck({ agentDir: "owner" });
  const fileWriter = createBackendMcpConfigFileWriter({ agentDir: "owner", bundledConfigPath: "bundle", assertPrivateStorage: checkConfigStorage });
  checkConfigStorage({ agentDir: "owner", configPath: "owner/mcp.json" });
  const configOwner = createBackendMcpConfigOwner({ agentDir: "owner", bundledConfigPath: "bundle", assertProcessOwner: () => {}, assertPrivateStorage: checkConfigStorage });
  const binding = await configOwner.prepare();
  const ownerCallbacks: Pick<McpExtensionOptions, "loadConfig" | "updateConfig"> = binding;
  const ownerPrepared: typeof prepared = binding.prepared;
  const ownerWrite: Promise<number> = configOwner.runWrite((scope) => { scope.assertOwner(); return 42; });
  const ownerDrain: Promise<void> = configOwner.drain();
  configOwner.dispose();
  // @ts-expect-error Owner authority/storage are explicit; no default backend or ACL bypass.
  createBackendMcpConfigOwner({ agentDir: "owner", bundledConfigPath: "bundle" });
  // @ts-expect-error Raw coordinator/generation are not exposed.
  configOwner.beginGeneration();
  // @ts-expect-error Auth and config locations are not interchangeable.
  checkConfigStorage({ agentDir: "owner", credentialPath: "owner/mcp-auth.json" });
  const nativeUpdater: NonNullable<McpExtensionOptions["updateConfig"]> = createBackendMcpConfigUpdater({ ...updaterOptions, writeConfig: fileWriter });
  // @ts-expect-error Private storage attestation is mandatory; never use SDK/default writer fallback.
  createBackendMcpConfigFileWriter({ agentDir: "owner", bundledConfigPath: "bundle" });
  const nativeServices: BackendMcpOwnerServices = { ...services, updateConfig: nativeUpdater };
  // @ts-expect-error Explicit synchronous Backend IO dependency is mandatory.
  createBackendMcpConfigUpdater(updaterOptions);
  // @ts-expect-error Async IO cannot acknowledge a synchronous SDK update.
  createBackendMcpConfigUpdater({ ...updaterOptions, writeConfig: async (request, scope) => {} });
  // @ts-expect-error Undefined return excludes Promise callbacks (unlike the SDK void callback).
  coordinator.runWriteSync(async (scope) => { scope.assertOwner(); });
  // @ts-expect-error Arbitrary private return data is not a synchronous write acknowledgment.
  coordinator.runWriteSync((scope) => 42);
  const drained: Promise<void> = coordinator.drain();
  coordinator.dispose();
  // @ts-expect-error Process authority is mandatory; no ambient writer owner.
  createBackendMcpWriteCoordinator({});
  // @ts-expect-error Raw generation manager is intentionally inaccessible.
  coordinator.generation;
  generationOwner.captureLease().assertOwner();
  generationLease.revoke();
  generationOwner.invalidate();
  generationOwner.dispose();
  // @ts-expect-error Explicit process authority is mandatory.
  createBackendMcpGenerationOwner({});
  // @ts-expect-error Generation identities/counters are intentionally private.
  generationLease.generation;
  const scopedOwner = createBackendMcpCredentialOwner({ agentDir: "owner", assertOwner: authority, assertPrivateStorage: checkStorage });
  authority({ namespace: "mcp__fixture", serverUrl: "https://example.invalid/" });
  // @ts-expect-error Runtime lease assertion is mandatory.
  createBackendMcpCredentialAuthority({ agentDir: "owner", bundledConfigPath: "bundle", prepared });
  // @ts-expect-error Caller server names are not canonical credential identities.
  authority({ name: "fixture", serverUrl: "https://example.invalid/" });
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
