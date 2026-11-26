/**
 * Two counter names staff would mix up at a glance: the same words once case, spacing,
 * punctuation and a trailing copy marker such as "(2)" or "copy" are set aside.
 *
 * "Counter 1" and "Counter 2" are different counters, so digits that are part of the name
 * still count; only a parenthesised number at the very end is treated as a copy marker.
 */
export function normaliseCounterName(name: string): string {
  return name
    .toLocaleLowerCase()
    .trim()
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+copy$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The first other counter whose name is close enough to `name` to confuse; null when none. */
export function nearDuplicateOf<T extends { label: string }>(
  name: string,
  others: ReadonlyArray<T>,
): T | null {
  const key = normaliseCounterName(name);
  if (!key) return null;
  return others.find((other) => normaliseCounterName(other.label) === key) ?? null;
}
