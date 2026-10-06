import type { MouseButtonName, UiAction } from "./contract.ts";
import type { OutlineNode } from "./outline.ts";
import { toFiniteNumber } from "./platform/coerce.ts";

export type ActionTarget = { ref: string } | { x: number; y: number } | { focus: { x: number; y: number } };

export type PreparedAction =
	| { action: "press" | "click"; target: ActionTarget; params: { button?: MouseButtonName; clickCount?: number }; establishesFocus: boolean; usesCurrentFocus: false; needsForeground: boolean }
	| { action: "setText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "typeText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "keypress"; target: ActionTarget; params: { keys: string[] }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "scroll"; target: ActionTarget; params: { scrollX: number; scrollY: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "drag"; target: ActionTarget; params: { path: Array<{ x: number; y: number }> }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "moveMouse"; target: ActionTarget; params: Record<string, never>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "wait"; params: { ms: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false };

export interface ActionState {
	currentFocus: boolean;
	currentFocusRef?: string;
	currentFocusPoint?: { x: number; y: number };
}

export interface ActionEnvironment {
	headless: boolean;
	image?: { width: number; height: number };
	supportsUnicodeTextInput: boolean;
	node(ref: string): OutlineNode;
	center(node: OutlineNode): { x: number; y: number };
	validatePoint(x: number, y: number, label?: string): void;
}

function mouseButton(value: unknown): MouseButtonName {
	return value === "right" || value === "middle" ? value : "left";
}

function clickCount(value: unknown, fallback = 1): number {
	return Math.max(1, Math.min(3, Math.round(toFiniteNumber(value, fallback))));
}

function scrollDelta(value: unknown): number {
	return Math.max(-10_000, Math.min(10_000, Math.round(toFiniteNumber(value, 0))));
}

function keys(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("keypress.keys must contain at least one key.");
	return value.map((key) => String(key));
}

function path(value: UiAction["path"], env: ActionEnvironment): Array<{ x: number; y: number }> {
	if (!Array.isArray(value) || value.length < 2) throw new Error("drag.path must contain at least two points.");
	return value.map((point, index) => {
		const x = Array.isArray(point) ? toFiniteNumber(point[0], NaN) : toFiniteNumber(point?.x, NaN);
		const y = Array.isArray(point) ? toFiniteNumber(point[1], NaN) : toFiniteNumber(point?.y, NaN);
		env.validatePoint(x, y, `Drag point ${index + 1}`);
		return { x, y };
	});
}

function nativeTarget(action: UiAction, operation: PreparedAction["action"], env: ActionEnvironment): ActionTarget {
	if (action.ref?.trim()) {
		const node = env.node(action.ref.trim());
		const semanticClick = operation === "click" || operation === "press";
		if (semanticClick && node.isTextInput) {
			if (env.image) {
				const point = env.center(node);
				env.validatePoint(point.x, point.y);
				return point;
			}
			if (node.wireRef && !node.pictureOnly && (node.canPress || node.canFocus || node.canSetValue)) return { ref: node.wireRef };
			throw new Error(`${operation} requires an image-bearing state or a semantically actionable editable ref.`);
		}
		const onlyIncidentalActions = node.actions.every((candidate) => candidate === "AXShowMenu" || candidate === "AXScrollToVisible");
		if (node.wireRef && !node.pictureOnly && (!semanticClick || node.canPress || node.canFocus || node.canSetValue || !onlyIncidentalActions)) {
			return { ref: node.wireRef };
		}
		const point = env.center(node);
		env.validatePoint(point.x, point.y);
		return point;
	}
	const x = toFiniteNumber(action.x, NaN);
	const y = toFiniteNumber(action.y, NaN);
	if (Number.isFinite(x) && Number.isFinite(y)) {
		env.validatePoint(x, y);
		return { x, y };
	}
	if (operation === "drag" && action.path?.length) return path(action.path, env)[0];
	throw new Error(`${operation} requires either ref or both x and y.`);
}

function supportsLinuxXtestText(text: string): boolean {
	return Array.from(text).every((character) => character === "\n" || character === "\t" || (character.length === 1 && character >= " " && character <= "~"));
}

function focusedTarget(state: ActionState, env: ActionEnvironment, operation: "typeText" | "keypress"): ActionTarget {
	if (state.currentFocusPoint) return { focus: state.currentFocusPoint };
	if (!env.image) {
		const guidance = operation === "typeText"
			? "Use setText with an editable @e ref for outline-only or headless text entry."
			: "Use a semantic press action on an @e ref for outline-only keyboard activation.";
		throw new Error(`Focused ${operation} needs an image-bearing focus target. ${guidance}`);
	}
	return { focus: { x: Math.floor(env.image.width / 2), y: Math.floor(env.image.height / 2) } };
}

function containsEditable(node: OutlineNode): boolean {
	if (node.isTextInput || node.canSetValue || node.role.toLowerCase().includes("text")) return true;
	return node.children.some(containsEditable);
}

export function prepareAction(action: UiAction, state: ActionState, env: ActionEnvironment): PreparedAction {
	const operation = action.action;
	const usesCurrentFocus = !env.headless && state.currentFocus && !action.ref && (operation === "typeText" || operation === "keypress");
	const needsSemanticText = operation === "typeText" && !env.supportsUnicodeTextInput && !supportsLinuxXtestText(action.text ?? "");
	const focusRef = !env.headless && operation === "typeText" && !action.ref && state.currentFocus && state.currentFocusRef && (!env.image || needsSemanticText) ? state.currentFocusRef : undefined;
	const explicitRefNode = operation === "typeText" && !env.supportsUnicodeTextInput && action.ref?.trim() ? env.node(action.ref.trim()) : undefined;
	if (needsSemanticText && explicitRefNode && !explicitRefNode.canSetValue) {
		throw new Error("Linux non-ASCII text requires an editable @e ref with setValue support. Use setText directly on that ref if available.");
	}
	if (explicitRefNode && (explicitRefNode.value.length > 0 || /secure|password/i.test(`${explicitRefNode.role} ${explicitRefNode.subrole}`))) {
		throw new Error("Linux typeText with an @e ref replaces the full value through AT-SPI. Use setText for intentional replacement, or focused ASCII typeText in an image-bearing state for insertion.");
	}
	const semanticFocusNode = focusRef && !env.supportsUnicodeTextInput && (!env.image || needsSemanticText) ? env.node(focusRef) : undefined;
	if (semanticFocusNode && !semanticFocusNode.canSetValue) {
		throw new Error("Linux semantic text input requires an editable @e ref with setValue support. Use setText directly on that ref if available.");
	}
	if (semanticFocusNode && (semanticFocusNode.value.length > 0 || /secure|password/i.test(`${semanticFocusNode.role} ${semanticFocusNode.subrole}`))) {
		throw new Error("Linux focused typeText through an editable ref replaces the full value. Use setText for intentional replacement, or focused ASCII typeText in an image-bearing state for insertion.");
	}
	if (needsSemanticText && !action.ref && !focusRef) {
		throw new Error("Linux physical typeText supports only printable ASCII. Use setText with an editable @e ref for non-ASCII text.");
	}
	const target = focusRef
		? nativeTarget({ ...action, ref: focusRef }, operation, env)
		: usesCurrentFocus ? focusedTarget(state, env, operation as "typeText" | "keypress") : nativeTarget(action, operation, env);
	const establishesFocus = !env.headless && Boolean(action.ref) && (operation === "click" || operation === "press") && containsEditable(env.node(action.ref!));
	const needsForeground = !env.headless && (operation === "click" || operation === "press") && "x" in target;

	switch (operation) {
		case "press":
		case "click": return { action: operation, target, params: { button: mouseButton(action.button), clickCount: clickCount(action.clickCount) }, establishesFocus, usesCurrentFocus: false, needsForeground };
		case "setText": return { action: operation, target, params: { text: action.text ?? "" }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "typeText": return { action: operation, target, params: { text: action.text ?? "" }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "keypress": return { action: operation, target, params: { keys: keys(action.keys) }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "scroll": return { action: operation, target, params: { scrollX: scrollDelta(action.scrollX), scrollY: scrollDelta(action.scrollY) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "drag": return { action: operation, target, params: { path: path(action.path, env) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "moveMouse": return { action: operation, target, params: {}, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
	}
}

export function updateActionFocus(
	action: UiAction,
	prepared: PreparedAction,
	state: ActionState,
	nodeForRef: (ref: string) => OutlineNode,
): void {
	if ((action.action !== "click" && action.action !== "press") || (prepared.action !== "click" && prepared.action !== "press")) return;
	const pointTargeted = "x" in prepared.target;
	state.currentFocus = prepared.establishesFocus || (action.action === "click" && pointTargeted);
	state.currentFocusRef = undefined;
	state.currentFocusPoint = undefined;
	if (!state.currentFocus) return;
	if ("x" in prepared.target) state.currentFocusPoint = { x: prepared.target.x, y: prepared.target.y };
	const ref = action.ref?.trim();
	if (!ref) return;
	const node = nodeForRef(ref);
	if (node.isTextInput || node.canSetValue || node.role.toLowerCase().includes("text")) state.currentFocusRef = ref;
}

export function canRetryInForeground(action: PreparedAction, outcome: "worked" | "didnt" | "unknown", headless: boolean): boolean {
	return !headless && outcome === "didnt" && (action.action === "typeText" || action.action === "keypress");
}

export function outcomeAfterCheck(current: "worked" | "didnt" | "unknown", check: "verified" | "preexisting" | "failed"): "worked" | "didnt" | "unknown" {
	if (check === "verified") return "worked";
	if (check === "failed") return "didnt";
	return current;
}

export function outcomeAfterObservedValues(
	current: "worked" | "didnt" | "unknown",
	actions: UiAction[],
	valueForRef: (ref: string) => string | undefined,
): "worked" | "didnt" | "unknown" {
	if (actions.length === 0 || actions.some((action) => action.action !== "setText" || !action.ref)) return current;
	const matches = actions.every((action) => valueForRef(action.ref!) === (action.text ?? ""));
	return matches ? "worked" : current;
}
