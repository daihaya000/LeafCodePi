import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createChildTranscriptWriter } from "./child-transcript.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafcode-child-transcript-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function sessionKey(sessionFile: string): string {
	const resolved = path.resolve(sessionFile);
	const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	return createHash("sha256").update(normalized).digest("hex");
}

describe("createChildTranscriptWriter", () => {
	it("stores an opaque parent-session key only on the initial record", () => {
		const sessionFile = path.join(root, "private-session.jsonl");
		const transcriptPath = path.join(root, "artifacts", "run_transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "foreground",
			runId: "run-1",
			agent: "reviewer",
			cwd: root,
			parentSessionFile: sessionFile,
		});
		const prompt = "x".repeat(16 * 1024);
		writer.writeInitialUserMessage(prompt);
		writer.writeStdoutLine("child output");

		const records = fs.readFileSync(transcriptPath, "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records[0]?.recordType).toBe("owner");
		expect(records[0]?.parentSessionKey).toBe(sessionKey(sessionFile));
		expect(records[0]?.parentSessionFile).toBeUndefined();
		expect(Buffer.byteLength(JSON.stringify(records[0]), "utf-8")).toBeLessThan(8 * 1024);
		expect(records[1]?.text).toBe(prompt);
		expect(records[1]).not.toHaveProperty("parentSessionKey");
		expect(records[2]).not.toHaveProperty("parentSessionKey");
	});
});
