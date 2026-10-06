import { describe, expect, it } from "vitest";
import { prepareAction, updateActionFocus, type ActionEnvironment, type ActionTarget, type PreparedAction } from "./actions.ts";
import type { OutlineNode } from "./outline.ts";

function editableField(): OutlineNode {
	return {
		ref: "@e1",
		wireRef: "wire-field",
		role: "AXTextField",
		subrole: "",
		identifier: "",
		title: "Search",
		description: "",
		value: "",
		actions: ["AXFocus"],
		canPress: true,
		canFocus: true,
		canSetValue: true,
		canScroll: false,
		canIncrement: false,
		canDecrement: false,
		isTextInput: true,
		rect: { x: 10, y: 20, w: 200, h: 40 },
		focused: false,
		offscreen: false,
		pictureOnly: false,
		truncated: false,
		text: [],
		children: [],
	};
}

function targetOf(prepared: PreparedAction): ActionTarget {
	if (!("target" in prepared)) throw new Error(`${prepared.action} has no target`);
	return prepared.target;
}

function environment(image?: { width: number; height: number }, supportsUnicodeTextInput = true): ActionEnvironment {
	const field = editableField();
	return {
		headless: false,
		image,
		supportsUnicodeTextInput,
		node: (ref) => {
			if (ref !== field.ref) throw new Error(`Unknown ref ${ref}`);
			return field;
		},
		center: () => ({ x: 110, y: 40 }),
		validatePoint: (x, y) => {
			if (!image || x < 0 || y < 0 || x >= image.width || y >= image.height) throw new Error("point requires an image-bearing root");
		},
	};
}

describe("focused text actions", () => {
	it("uses semantic setText for outline-only observations", () => {
		const prepared = prepareAction({ action: "setText", ref: "@e1", text: "query" }, { currentFocus: false }, environment());
		expect(targetOf(prepared)).toEqual({ ref: "wire-field" });
	});

	it("keeps a semantic editable ref for typeText in outline-only mode", () => {
		const env = environment();
		const state = { currentFocus: false };
		const click = prepareAction({ action: "click", ref: "@e1" }, state, env);

		expect(targetOf(click)).toEqual({ ref: "wire-field" });
		expect(click.establishesFocus).toBe(true);
		updateActionFocus({ action: "click", ref: "@e1" }, click, state, env.node);

		const type = prepareAction({ action: "typeText", text: "query" }, state, env);
		expect(targetOf(type)).toEqual({ ref: "wire-field" });
		expect(type.usesCurrentFocus).toBe(true);
	});

	it("routes non-ASCII Linux typing through the focused editable ref", () => {
		const env = environment({ width: 800, height: 600 }, false);
		const state = { currentFocus: true, currentFocusRef: "@e1" };
		const prepared = prepareAction({ action: "typeText", text: "日本語" }, state, env);

		expect(targetOf(prepared)).toEqual({ ref: "wire-field" });
	});

	it("rejects unsupported Linux physical text before partially typing it", () => {
		const env = environment(undefined, false);
		expect(() => prepareAction({ action: "typeText", text: "prefix 日本語" }, { currentFocus: true }, env)).toThrow(/supports only printable ASCII/i);
	});

	it("does not replace a non-empty Linux field during semantic typeText fallback", () => {
		const env = environment({ width: 800, height: 600 }, false);
		env.node("@e1").value = "existing";
		const state = { currentFocus: true, currentFocusRef: "@e1" };
		expect(() => prepareAction({ action: "typeText", text: "日本語" }, state, env)).toThrow(/replaces the full value/i);
	});

	it("preserves the clicked caret location for image-backed keyboard input", () => {
		const env = environment({ width: 800, height: 600 });
		const state = { currentFocus: false };
		const click = prepareAction({ action: "click", ref: "@e1" }, state, env);
		updateActionFocus({ action: "click", ref: "@e1" }, click, state, env.node);

		const type = prepareAction({ action: "typeText", text: "query" }, state, env);
		expect(targetOf(type)).toEqual({ focus: { x: 110, y: 40 } });
	});
});
