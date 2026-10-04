import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { BackendMcpExtensionsResult } from "./mcp-native-extensions.mjs";
export type BackendMcpNativeSessionProvider = (sessionCwd: string) => BackendMcpExtensionsResult;
export type BackendMcpNativeSession = { active: boolean; factories: ExtensionFactory[]; issues: { code: string }[] };
/** Register a session-owned native MCP shutdown action and return its idempotent disposer. */
export function registerBackendMcpNativeSessionShutdownAction(sessionId: string, stop: () => void | Promise<void>): () => void;
/** Run all captured shutdown actions for one session, isolating individual action failures. */
export function runBackendMcpNativeSessionShutdownActions(sessionId: string): Promise<number>;
/** INTERNAL process-local activation switch; undefined (default) keeps the legacy adapter path.
 * Synchronous provider only. Not called by production code yet. */
export function setBackendMcpNativeSessionProvider(next: BackendMcpNativeSessionProvider | undefined): void;
/** Native factories for one session when active; never falls back to the adapter once active. */
export function resolveBackendMcpNativeSession(sessionCwd: string): BackendMcpNativeSession;
/** Bundled extension entries to load; drops leafcode-mcp-adapter when native MCP is active. */
export function bundledPathsForNativeMcp<T extends { name: string }>(entries: readonly T[], active: boolean): T[];
/** Resolve the provider per load/reload. Standalone codemode is used only when native MCP is inactive;
 * an active but failed provider never falls back. */
export function nativeMcpExtensionFactory(sessionCwd: string, standaloneCodemode?: ExtensionFactory): ExtensionFactory;
