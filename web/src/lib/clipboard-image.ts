type ClipboardEventLike = {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
};

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
