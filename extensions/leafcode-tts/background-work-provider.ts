import { randomUUID } from "node:crypto";
import { registerBackgroundWorkProvider } from "../leafcode-subagents/src/api/background-work.ts";

export function registerTtsSpeakerBackgroundWorkProvider(sessionId: string, disposeSpeaker: () => void): () => void {
	let unregister = () => {};
	unregister = registerBackgroundWorkProvider({
		name: `leafcode-tts:${randomUUID()}`,
		listActiveWork: () => [],
		listShutdownResources: () => [{ id: "speaker", sessionId }],
		captureStopWork: (item) => {
			if (item.id !== "speaker" || item.sessionId !== sessionId) return undefined;
			return () => {
				try { disposeSpeaker(); }
				finally { unregister(); }
			};
		},
	});
	return unregister;
}
