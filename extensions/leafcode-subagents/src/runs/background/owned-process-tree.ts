import { spawnSync } from "node:child_process";
import type { ProcessTreeTerminalV1 } from "../../shared/types.ts";

const DEFAULT_TERM_GRACE_MS = 3000;
const DEFAULT_KILL_VERIFY_MS = 1000;
const VERIFY_INTERVAL_MS = 25;

type SignalResult = "sent" | "absent" | { diagnostic: string };

function diagnostic(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function signalProcess(id: number, signal: NodeJS.Signals): SignalResult {
	try {
		process.kill(id, signal);
		return "sent";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
		return { diagnostic: diagnostic(error) };
	}
}

function activeProcessGroupMembers(processGroupId: number): number[] | { diagnostic: string } {
	const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf-8" });
	if (result.error || result.status !== 0) {
		return { diagnostic: result.error ? diagnostic(result.error) : (result.stderr.trim() || `ps exited with ${result.status}`) };
	}
	const members: number[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
		if (!match || Number(match[2]) !== processGroupId || match[3]!.startsWith("Z")) continue;
		members.push(Number(match[1]));
	}
	return members;
}

async function waitUntilGroupTerminal(
	processGroupId: number,
	timeoutMs: number,
): Promise<false | { state: "enumeration-failed" | "still-active"; diagnostic: string }> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const members = activeProcessGroupMembers(processGroupId);
		if (Array.isArray(members) && members.length === 0) return false;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			if (!Array.isArray(members)) return { state: "enumeration-failed", diagnostic: members.diagnostic };
			return { state: "still-active", diagnostic: `Process group ${processGroupId} still has active members: ${members.join(", ")}.` };
		}
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, remaining)));
	}
}

function observed(processGroupId: number): ProcessTreeTerminalV1 {
	return { state: "observed", mechanism: "posix-process-group", processGroupId, verifiedAt: Date.now() };
}

function observedWindowsTree(processId: number): ProcessTreeTerminalV1 {
	return { state: "observed", mechanism: "windows-taskkill-tree", processId, verifiedAt: Date.now() };
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but this user cannot signal it.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitUntilProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
	}
	return true;
}

/**
 * Windows has no process groups, so a single PID signal orphans children.
 * `taskkill /T` walks the child tree for us; the parent PID is polled until it
 * is gone so the result stays an observation rather than an assumption. A
 * nonzero taskkill status only matters while the process is still alive —
 * taskkill reports "already gone" with a localized message.
 */
function taskkillTree(pid: number): SignalResult {
	if (!processAlive(pid)) return "absent";
	const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
		encoding: "utf-8",
		windowsHide: true,
	});
	if (result.error) {
		return (result.error as NodeJS.ErrnoException).code === "ENOENT"
			? "absent"
			: { diagnostic: diagnostic(result.error) };
	}
	if (result.status === 0) return "sent";
	if (!processAlive(pid)) return "absent";
	return { diagnostic: result.stderr.trim() || result.stdout.trim() || `taskkill exited with ${result.status}` };
}

/** Owns one writer process group and arbitrates its cleanup exactly once. */
export interface OwnedProcessTreeController {
	terminate(): Promise<ProcessTreeTerminalV1>;
	finishAfterWriterClose(): Promise<ProcessTreeTerminalV1>;
}

export function createOwnedProcessTreeController(
	pid: number,
	options: { termGraceMs?: number; killVerifyMs?: number } = {},
): OwnedProcessTreeController {
	let termination: Promise<ProcessTreeTerminalV1> | undefined;
	const posixGroupOwned = process.platform !== "win32";
	const target = posixGroupOwned ? -pid : pid;

	const terminate = (): Promise<ProcessTreeTerminalV1> => {
		if (termination) return termination;
		termination = (async () => {
			if (!posixGroupOwned) {
				const killed = taskkillTree(pid);
				if (killed !== "sent" && killed !== "absent") {
					return { state: "unknown", reason: "signal-failed", diagnostic: killed.diagnostic };
				}
				const gone = await waitUntilProcessGone(pid, options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS);
				if (!gone) {
					return { state: "unknown", reason: "verification-failed", diagnostic: `Process ${pid} is still running after taskkill /T.` };
				}
				return observedWindowsTree(pid);
			}
			const term = signalProcess(target, "SIGTERM");
			if (term !== "sent" && term !== "absent") {
				return { state: "unknown", reason: "signal-failed", diagnostic: term.diagnostic };
			}
			const termExit = await waitUntilGroupTerminal(pid, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
			if (termExit === false) return observed(pid);

			const kill = signalProcess(target, "SIGKILL");
			if (kill !== "sent" && kill !== "absent") {
				const members = activeProcessGroupMembers(pid);
				if (!Array.isArray(members) || members.length > 0) {
					return { state: "unknown", reason: "signal-failed", diagnostic: kill.diagnostic };
				}
			}
			const killExit = await waitUntilGroupTerminal(pid, options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS);
			if (killExit !== false) {
				return { state: "unknown", reason: "verification-failed", diagnostic: killExit.diagnostic };
			}
			return observed(pid);
		})();
		return termination;
	};

	return { terminate, finishAfterWriterClose: terminate };
}
