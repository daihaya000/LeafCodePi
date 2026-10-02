import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { BackendMcpExtensionsResult } from "./mcp-native-extensions.mjs";
export type BackendMcpNativeSessionProvider = (sessionCwd: string) => BackendMcpExtensionsResult;
export type BackendMcpNativeSession = { active: boolean; factories: ExtensionFactory[]; issues: { code: string }[] };
/** INTERNAL process-local activation switch; undefined (default) keeps the legacy adapter path.
 * Synchronous provider only. Not called by production code yet. */
export function setBackendMcpNativeSessionProvider(next: BackendMcpNativeSessionProvider | undefined): void;
/** Native factories for one session when active; never falls back to the adapter once active. */
export function resolveBackendMcpNativeSession(sessionCwd: string): BackendMcpNativeSession;
/** Bundled extension entries to load; drops leafcode-mcp-adapter when native MCP is active. */
export function bundledPathsForNativeMcp<T extends { name: string }>(entries: readonly T[], active: boolean): T[];
/** One loader factory that resolves the provider per invocation (and per reload), never capturing a
 * binding that a config write may have retired. */
export function nativeMcpExtensionFactory(sessionCwd: string): ExtensionFactory;
