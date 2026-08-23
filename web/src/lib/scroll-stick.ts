/** True when the viewport is within `threshold` px of the scroll bottom. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 80,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

/** The largest legal scrollTop for a scroll container. */
export function maxScrollTop(clientHeight: number, scrollHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/** Clamp programmatic scroll targets so callers cannot overshoot the content. */
export function clampScrollTop(top: number, clientHeight: number, scrollHeight: number): number {
  return Math.min(maxScrollTop(clientHeight, scrollHeight), Math.max(0, top));
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
