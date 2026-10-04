import { randomUUID } from "node:crypto";
import { registerBackgroundWorkProvider } from "../../leafcode-subagents/src/api/background-work.ts";

interface ShutdownResource {
	shutdown: () => void | Promise<void>;
}

const shutdownResources = new Map<string, ShutdownResource>();

registerBackgroundWorkProvider({
	name: `leafcode-computer-use:${randomUUID()}`,
	listActiveWork: () => [],
	listShutdownResources: () => [...shutdownResources.keys()].map((sessionId) => ({ id: "runtime", sessionId })),
	captureStopWork: (item) => {
		if (item.id !== "runtime") return undefined;
		const resource = shutdownResources.get(item.sessionId);
		if (!resource) return undefined;
		return async () => {
			if (shutdownResources.get(item.sessionId) !== resource) return;
			try { await resource.shutdown(); }
			finally {
				if (shutdownResources.get(item.sessionId) === resource) shutdownResources.delete(item.sessionId);
			}
		};
	},
});

export function registerComputerUseShutdownResource(sessionId: string, shutdown: () => void | Promise<void>): () => void {
	const resource = { shutdown };
	shutdownResources.set(sessionId, resource);
	return () => {
		if (shutdownResources.get(sessionId) === resource) shutdownResources.delete(sessionId);
	};
}
