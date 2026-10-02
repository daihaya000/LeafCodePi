type OperationState = { generation: number; preparing: number; editing: boolean; cancellations: Set<() => void> };
const key = Symbol.for("leafcode.task-operation-guard.v1");
function states(): Map<string, OperationState> {
  const global = globalThis as typeof globalThis & { [key]?: Map<string, OperationState> };
  return global[key] ??= new Map();
}
function stateFor(id: string): OperationState {
  const map = states();
  let state = map.get(id);
  if (!state) { state = { generation: 0, preparing: 0, editing: false, cancellations: new Set() }; map.set(id, state); }
  return state;
}
function prune(id: string, state: OperationState): void {
  if (!state.preparing && !state.editing && states().get(id) === state) states().delete(id);
}
function busy(): never {
  throw Object.assign(new Error("セッションの操作中です。完了してから再試行してください"), { status: 409 });
}
/** A preparation starts before selection/ensureLive, not only when the SDK prompt is queued. */
export function beginTaskPreparation(id: string) {
  const state = stateFor(id);
  if (state.editing) busy();
  state.preparing++;
  const generation = state.generation;
  let released = false;
  const isCurrent = () => !released && generation === state.generation;
  const cancelledError = () => Object.assign(new Error("送信準備は停止・取消されました"), { status: 409 });
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(cancelledError()); });
  cancelled.catch(() => {});
  (state.cancellations ??= new Set()).add(cancel);
  const assertCurrent = () => { if (!isCurrent()) throw cancelledError(); };
  return {
    isCurrent,
    assertCurrent,
    // Only race read-only selection/validation, never an async session mutation.
    waitFor: <T>(work: PromiseLike<T>): Promise<T> => {
      assertCurrent();
      return Promise.race([work, cancelled]);
    },
    release: () => {
      if (released) return;
      released = true; state.cancellations.delete(cancel); state.preparing--; prune(id, state);
    },
  };
}
/** Stops remain non-blocking, and invalidate even a cold task's pending Auto request. */
export function invalidateTaskPreparations(id: string): void {
  const state = states().get(id);
  if (state) {
    state.generation++;
    for (const cancel of state.cancellations ?? []) cancel();
  }
}
export function hasTaskPreparation(id: string): boolean {
  return Boolean(states().get(id)?.preparing);
}
export function isTaskTreeEditing(id: string): boolean {
  return states().get(id)?.editing === true;
}
/** Keep the tree gate closed until a session mutation really completes, even after a stop. */
export async function withTaskSessionMutation<T>(id: string, mutate: () => Promise<T>): Promise<T> {
  const preparation = beginTaskPreparation(id);
  try { return await mutate(); } finally { preparation.release(); }
}
/** Reject overlap instead of queueing an edit against a potentially different transcript. */
export async function withTaskTreeEdit<T>(id: string, edit: () => Promise<T>): Promise<T> {
  const state = stateFor(id);
  if (state.editing || state.preparing) busy();
  state.editing = true;
  try { return await edit(); }
  finally { state.editing = false; prune(id, state); }
}
