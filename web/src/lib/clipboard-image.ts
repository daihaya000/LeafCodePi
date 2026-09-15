type ClipboardEventLike = {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
};

export const LARGE_PASTE_CHAR_LIMIT = 10_000;
export const PASTED_TEXT_FILE_NAME = "pasted-text.txt";

/** Composer の添付が今受けられるか（ボタン無効と同じ条件）。 */
export function canAttachComposerImages(input: {
  goalLoopEnabled?: boolean;
  compacting?: boolean;
  submitting?: boolean;
  archived?: boolean;
}): boolean {
  return (
    !input.goalLoopEnabled &&
    !input.compacting &&
    !input.submitting &&
    !input.archived
  );
}

/** クリップボードに画像ファイルがあるか（添付可否とは独立）。 */
export function clipboardHasImage(event: ClipboardEventLike): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) return true;
  }
  return false;
}

/**
 * クリップボードに画像があれば抽出して onFiles へ渡し true を返す。
 * 画像以外のペースト（テキストなど）では何もせず false を返す。
 * 呼び出し側は true のとき必ず preventDefault すること（添付を拒否する場合も）。
 */
export function pasteImage(onFiles: (files: FileList) => void, event: ClipboardEventLike): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0) return false;
  onFiles(files as unknown as FileList);
  return true;
}

/** 10,000文字を超える貼り付けを、編集可能なテキストファイルへ変換する。 */
export function pasteLargeText(onFiles: (files: FileList) => void, event: ClipboardEventLike): boolean {
  if (clipboardHasImage(event)) return false;
  const text = event.clipboardData?.getData?.("text/plain") ?? "";
  if (text.length <= LARGE_PASTE_CHAR_LIMIT) return false;
  const file = new File([text], PASTED_TEXT_FILE_NAME, { type: "text/plain" });
  onFiles([file] as unknown as FileList);
  return true;
}
