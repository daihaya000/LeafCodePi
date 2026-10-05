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
 * `layoutChanged` marks a scroll event whose content height differs from the
 * last one we saw: a card collapsing (browser clamps scrollTop) and then
 * another auto-expanding before the event fires looks like an upward scroll
 * that is not at the bottom, but it is layout, not the user.
 */
export function nextStickState(
  currentlyStuck: boolean,
  scrollTop: number,
  prevScrollTop: number,
  atBottom: boolean,
  upwardThreshold = 4,
  layoutChanged = false,
  /** True when scrollHeight shrank (card collapse). Stream growth must not use this. */
  heightDecreased = false,
): boolean {
  if (atBottom) return true;
  // A clear upward scroll unsticks even while streaming grows the content.
  // Only a height *shrink* (collapse + browser clamp) must keep stick mode.
  if (scrollTop < prevScrollTop - upwardThreshold) {
    if (layoutChanged && heightDecreased) return currentlyStuck;
    return false;
  }
  if (layoutChanged) return currentlyStuck;
  return currentlyStuck;
}
