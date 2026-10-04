import { afterEach, describe, expect, it } from "vitest";
import { boundToolError, clearStoredOutputs, applyOutputEnvelope, MODEL_TEXT_MAX_BYTES, readStoredOutput } from "./output.ts";

afterEach(() => {
	clearStoredOutputs("session-a");
	clearStoredOutputs("session-b");
});

function storeLargeOutput(ownerSessionId: string): string {
	const result = applyOutputEnvelope("find_roots", {
		content: [{ type: "text", text: ownerSessionId.repeat(MODEL_TEXT_MAX_BYTES + 1) }],
	} as never, ownerSessionId);
	const ref = result.content[0]?.type === "text"
		? /ref: "(@o\d+)"/.exec(result.content[0].text)?.[1]
		: undefined;
	if (!ref) throw new Error("Expected a stored-output ref in the output envelope.");
	return ref;
}

describe("session-owned stored outputs", () => {
	it("tags oversized errors with their owning session", () => {
		const error = boundToolError("find_roots", "problem".repeat(MODEL_TEXT_MAX_BYTES), "session-a");
		const ref = /ref: "(@o\d+)"/.exec(error.message)?.[1];
		expect(ref).toBeDefined();
		expect(readStoredOutput(ref!, 0, "session-b")).toBeUndefined();
		expect(readStoredOutput(ref!, 0, "session-a")?.text).toContain("problem");
	});

	it("allows reads and cleanup only for the owning session", () => {
		const refA = storeLargeOutput("session-a");
		const refB = storeLargeOutput("session-b");

		expect(readStoredOutput(refA, 0, "session-b")).toBeUndefined();
		expect(readStoredOutput(refA, 0, "session-a")?.text).toContain("a");

		clearStoredOutputs("session-a");

		expect(readStoredOutput(refA, 0, "session-a")).toBeUndefined();
		expect(readStoredOutput(refB, 0, "session-b")?.text).toContain("b");
	});
});
