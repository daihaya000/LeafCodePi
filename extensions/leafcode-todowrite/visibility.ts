/** Session-scoped model visibility, shared with the host's native discovery adapters.
 * Symbol.for keeps the bridge shared across the host bundle and separately loaded extensions.
 * Registration/permissions never change; tool_call remains the execution authority.
 */
type ToolVisibility = (name: string) => boolean;
const KEY = Symbol.for("leafcode.todowrite.visibility.v1");
const host = globalThis as typeof globalThis & { [KEY]?: WeakMap<object, ToolVisibility> };
const visibility = host[KEY] ??= new WeakMap<object, ToolVisibility>();

export function publishTodoVisibility(sessionManager: object, predicate: ToolVisibility): void {
  visibility.set(sessionManager, predicate);
}

export function clearTodoVisibility(sessionManager: object, predicate: ToolVisibility): void {
  if (visibility.get(sessionManager) === predicate) visibility.delete(sessionManager);
}

export function todoToolVisible(sessionManager: object | undefined, name: string): boolean {
  return !sessionManager || (visibility.get(sessionManager)?.(name) ?? true);
}
