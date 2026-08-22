/** タスクタブ・Sidebar タスクのドラッグ MIME。DnD 横断でこのファイルだけを見る。 */

export const TASK_DRAG_MIME = "application/x-leafcodepi-task";

/** dragstart で DataTransfer へ格納。text/plain は外部 DnD のフォールバック用。 */
export function setTaskDragData(dataTransfer: DataTransfer, taskId: string): void {
  dataTransfer.setData(TASK_DRAG_MIME, taskId);
  dataTransfer.setData("text/plain", taskId);
}

/** dragover 等で types 判定に使う（getData は drop まで取れないことがあるため）。 */
export function isTaskDrag(types: readonly string[]): boolean {
  return types.includes(TASK_DRAG_MIME);
}

/** drop で取り出す。MIME が無い場合は text/plain からの回復を試みる。 */
export function taskDragIdFrom(dataTransfer: DataTransfer): string | null {
  try {
    return dataTransfer.getData(TASK_DRAG_MIME) || dataTransfer.getData("text/plain") || null;
  } catch {
    return null;
  }
}
