type ClipboardEventLike = {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
};

/** Composer の画像添付が今受けられるか（ボタン無効と同じ条件）。 */
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

/**
 * クリップボードに画像があれば抽出して onFiles へ渡し true を返す。
 * 画像以外のペースト（テキストなど）では何もせず false を返す。
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
