import { describe, expect, it } from "vitest";
import { parseLookResponse, rankedTextMatch, searchOutlineRanked } from "./outline.ts";

function lookWithLabels(labels: string[]) {
	return parseLookResponse({
		lookId: "look-1",
		window: { windowId: 1, framePoints: { x: 0, y: 0, w: 800, h: 600 }, scaleFactor: 1 },
		outline: {
			ref: "root",
			role: "AXWindow",
			children: labels.map((title, index) => ({ ref: `node-${index}`, role: "AXButton", title, children: [] })),
		},
	}).parsedOutline!;
}

describe("ranked UI text matching", () => {
	it("keeps transposition matches while using the bounded rolling-row distance", () => {
		expect(rankedTextMatch(["open"], "opne")).toEqual({ reason: "fuzzy", score: 0.75 });
	});

	it("skips candidates whose length difference cannot meet the fuzzy threshold", () => {
		expect(rankedTextMatch(["abcdefghij"], "abx")).toBeUndefined();
	});

	it("keeps exact results ahead of fuzzy candidates", () => {
		const outline = lookWithLabels(["Open", "Opne"]);
		const result = searchOutlineRanked(outline, "open");
		expect(result.matches.map((match) => match.label)).toEqual(["Open", "Opne"]);
		expect(result.matches[0].matchReason).toBe("exact");
		expect(result.matches[1].matchReason).toBe("fuzzy");
	});
});
