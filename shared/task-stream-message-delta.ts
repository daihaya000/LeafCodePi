export type SentMessagePage = { ids: string[]; jsonById: Map<string, string> };

/**
 * Indices of the rows in a new page that the client does not already hold verbatim, or undefined when
 * the page is not "previous page, trimmed at the front, with rows appended at the end". Anything else
 * (re-identified rows, removals in the middle, rewinds) needs a full page.
 */
export function messagePageDelta(
  previous: SentMessagePage,
  ids: readonly string[],
  jsons: readonly string[],
): number[] | undefined {
  if (ids.length === 0 || previous.ids.length === 0) return undefined;
  if (new Set(ids).size !== ids.length) return undefined;
  const start = previous.ids.indexOf(ids[0]!);
  if (start < 0) return undefined;
  const retained = previous.ids.length - start;
  if (ids.length < retained) return undefined;
  const changed: number[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    if (index < retained) {
      if (previous.ids[start + index] !== id) return undefined;
      if (previous.jsonById.get(id) !== jsons[index]) changed.push(index);
    } else {
      // An appended row must be new; an id seen earlier would be a reorder.
      if (previous.jsonById.has(id)) return undefined;
      changed.push(index);
    }
  }
  return changed;
}
