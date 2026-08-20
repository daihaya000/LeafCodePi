/** True when the viewport is within `threshold` px of the scroll bottom. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 80,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * Stick-to-bottom follow mode.
 * Unstick only on an explicit upward scroll — content growth that moves the
 * bottom away must not drop follow mode (scroll anchoring / streaming).
 */
export function nextStickState(
  currentlyStuck: boolean,
  scrollTop: number,
  prevScrollTop: number,
  atBottom: boolean,
  upwardThreshold = 4,
): boolean {
  if (atBottom) return true;
  if (scrollTop < prevScrollTop - upwardThreshold) return false;
  return currentlyStuck;
}
