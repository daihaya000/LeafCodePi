import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Details } from "../shared/types.ts";

export const WORKFLOW_CHAT_PROGRESS_MODES = ["auto", "off", "live-card"] as const;
export type WorkflowChatProgressMode = typeof WORKFLOW_CHAT_PROGRESS_MODES[number];
export type ResolvedWorkflowChatProgressMode = Exclude<WorkflowChatProgressMode, "auto">;

export interface GitRepositoryIdentity {
	root: string;
	commonDir: string;
}

export interface WorkflowChatProgressProjection {
	mode: ResolvedWorkflowChatProgressMode;
	repoRelation: "same" | "other";
	repoLabel?: string;
}

interface ResolveWorkflowChatProgressInput {
	requested: unknown;
	parentCwd: string;
	workflowCwd: string;
	background: boolean;
}

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", windowsHide: true });
	if (result.status !== 0) return undefined;
	const output = result.stdout.trim();
	return output || undefined;
}

function realPath(value: string): string {
	try {
		return fs.realpathSync.native(value);
	} catch {
		return path.resolve(value);
	}
}

/**
 * Repository identity rarely changes, but `git rev-parse` is a synchronous
 * spawn that stops the event loop for the caller. Cache it briefly per cwd so a
 * burst of workflow starts resolves the identity once instead of per call.
 */
const IDENTITY_CACHE_TTL_MS = 10_000;
const IDENTITY_CACHE_LIMIT = 32;
const identityCache = new Map<string, { resolvedAt: number; identity: GitRepositoryIdentity | undefined }>();

export function resolveGitRepositoryIdentity(cwd: string): GitRepositoryIdentity | undefined {
	const resolvedCwd = realPath(cwd);
	const now = Date.now();
	const cached = identityCache.get(resolvedCwd);
	if (cached && now - cached.resolvedAt < IDENTITY_CACHE_TTL_MS) return cached.identity;
	const identity = probeGitRepositoryIdentity(resolvedCwd);
	if (identityCache.size >= IDENTITY_CACHE_LIMIT) {
		const oldest = [...identityCache.entries()].sort((a, b) => a[1].resolvedAt - b[1].resolvedAt)[0];
		if (oldest) identityCache.delete(oldest[0]);
	}
	identityCache.set(resolvedCwd, { resolvedAt: now, identity });
	return identity;
}

/** Test-only: forget memoized repository identities. */
export function resetGitRepositoryIdentityCacheForTests(): void {
	identityCache.clear();
}

function probeGitRepositoryIdentity(cwd: string): GitRepositoryIdentity | undefined {
	// One spawn instead of three: output is one value per requested option, in order.
	const [inside, root, commonDir] = (git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"]) ?? "").split(/\r?\n/).map((line) => line.trim());
	if (inside !== "true" || !root || !commonDir) return undefined;
	const commonDirPath = path.isAbsolute(commonDir)
		? commonDir
		: [path.resolve(cwd, commonDir), path.resolve(root, commonDir)].find((candidate) => fs.existsSync(candidate)) ?? path.resolve(root, commonDir);
	return {
		root: realPath(root),
		commonDir: realPath(commonDirPath),
	};
}

function isSameGitRepositoryIdentity(left: GitRepositoryIdentity | undefined, right: GitRepositoryIdentity | undefined): boolean {
	if (!left || !right) return false;
	return left.commonDir === right.commonDir || left.root === right.root;
}

export function isSameGitRepository(leftCwd: string, rightCwd: string): boolean {
	return isSameGitRepositoryIdentity(resolveGitRepositoryIdentity(leftCwd), resolveGitRepositoryIdentity(rightCwd));
}

function normalizeRequestedMode(value: unknown): { mode?: WorkflowChatProgressMode; error?: string } {
	if (value === undefined) return { mode: "auto" };
	if (typeof value !== "string" || !WORKFLOW_CHAT_PROGRESS_MODES.includes(value as WorkflowChatProgressMode)) {
		return { error: `chatProgress must be one of: ${WORKFLOW_CHAT_PROGRESS_MODES.join(", ")}.` };
	}
	return { mode: value as WorkflowChatProgressMode };
}

export function resolveWorkflowChatProgress(input: ResolveWorkflowChatProgressInput): { projection?: WorkflowChatProgressProjection; error?: string } {
	const requested = normalizeRequestedMode(input.requested);
	if (requested.error) return { error: requested.error };
	const parentIdentity = resolveGitRepositoryIdentity(input.parentCwd);
	const workflowIdentity = path.resolve(input.parentCwd) === path.resolve(input.workflowCwd)
		? parentIdentity
		: resolveGitRepositoryIdentity(input.workflowCwd);
	const sameRepo = !!(
		parentIdentity
		&& workflowIdentity
		&& (parentIdentity.commonDir === workflowIdentity.commonDir || parentIdentity.root === workflowIdentity.root)
	);
	const repoLabel = workflowIdentity ? path.basename(workflowIdentity.root) : undefined;
	const repoRelation = sameRepo ? "same" : "other";

	const requestedMode = requested.mode ?? "auto";
	let mode: ResolvedWorkflowChatProgressMode;
	if (requestedMode === "auto") mode = sameRepo && !input.background ? "live-card" : "off";
	else mode = requestedMode;

	if (mode === "live-card" && !sameRepo) return { error: "chatProgress: 'live-card' is only available for workflowScript runs in the same Git repository." };
	if (mode === "live-card" && input.background) return { error: "chatProgress: 'live-card' is unavailable for async workflowScript. Async workflows have no inline live card; omit chatProgress or use auto/off. Use async:false only when the parent must block." };
	return { projection: { mode, repoRelation, ...(repoLabel ? { repoLabel } : {}) } };
}

export interface WorkflowChatProgressRow {
	key: string;
	state: "running" | "complete" | "failed" | "detached" | "stopped";
	label?: string;
	phase?: string;
	runId?: string;
	durationMs?: number;
	error?: string;
}

function cleanLabel(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildWorkflowChatProgressRows(trace: NonNullable<Details["workflow"]>["trace"]): WorkflowChatProgressRow[] {
	const rows = new Map<string, WorkflowChatProgressRow>();
	for (const entry of trace) {
		if (entry.operation !== "run") continue;
		const existing = rows.get(entry.key);
		if (entry.state === "reused") {
			if (existing) {
				const label = cleanLabel(entry.label);
				const phase = cleanLabel(entry.phase);
				if (label) existing.label = label;
				if (phase) existing.phase = phase;
			}
			continue;
		}
		const next: WorkflowChatProgressRow = existing ?? { key: entry.key, state: "running" };
		next.state = entry.state === "completed"
			? "complete"
			: entry.state === "failed"
				? "failed"
				: entry.state === "detached"
					? "detached"
					: entry.state === "stopped"
						? "stopped"
						: "running";
		const label = cleanLabel(entry.label);
		const phase = cleanLabel(entry.phase);
		if (label) next.label = label;
		if (phase) next.phase = phase;
		if (entry.runId === undefined) delete next.runId;
		else next.runId = entry.runId;
		if (entry.durationMs === undefined) delete next.durationMs;
		else next.durationMs = entry.durationMs;
		if (entry.error === undefined) delete next.error;
		else next.error = entry.error;
		rows.set(entry.key, next);
	}
	return [...rows.values()];
}
