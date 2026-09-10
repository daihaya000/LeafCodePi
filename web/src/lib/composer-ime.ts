/**
 * IME composition 中のショートカット送信を抑止する判定。
 * compositionStart/End の ref だけでは、Blur で End が欠ける / keydown で
 * isComposing だけが立つケースを取りこぼすため、両方を見る。
 */
export function isImeComposingEvent(event: {
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return Boolean(
    event.nativeEvent?.isComposing ||
      event.isComposing ||
      event.keyCode === 229,
  );
}
