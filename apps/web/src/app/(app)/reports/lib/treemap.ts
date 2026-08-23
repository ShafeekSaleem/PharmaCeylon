export type TreemapRect = { x: number; y: number; w: number; h: number };

/** How "far from square" a row of tiles would be at the given perpendicular `length` — the
 *  squarify algorithm's core metric (Bruls, Huizing & van Wijk, 2000). Lower is more square. */
function worstRatio(row: number[], length: number): number {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Infinity;
  const max = Math.max(...row);
  const min = Math.min(...row);
  const lengthSq = length * length;
  const sumSq = sum * sum;
  return Math.max((lengthSq * max) / sumSq, sumSq / (lengthSq * min));
}

/** `spanIsWidth`: true lays the row out horizontally, spanning the container's full (shorter)
 *  width, with each tile's height equal to the row's shared `thickness`; false lays it out as a
 *  vertical column spanning the full (shorter) height instead, with `thickness` as shared width.
 *  Always spanning the SHORTER remaining side (decided by the caller) is what keeps tiles close
 *  to square instead of degenerating into thin slivers. */
function layoutRow(row: number[], length: number, x: number, y: number, spanIsWidth: boolean): TreemapRect[] {
  const rowSum = row.reduce((a, b) => a + b, 0);
  const thickness = length > 0 ? rowSum / length : 0;
  let offset = 0;
  return row.map((v) => {
    const extent = thickness > 0 ? v / thickness : 0;
    const rect: TreemapRect = spanIsWidth ? { x: x + offset, y, w: extent, h: thickness } : { x, y: y + offset, w: thickness, h: extent };
    offset += extent;
    return rect;
  });
}

/**
 * Squarified treemap layout — `values` should already be pre-sorted descending (the algorithm
 * assumes this, same as the reference paper) and will be laid out to exactly fill the `w`×`h`
 * rectangle starting at `x,y`, in the same units as `w`/`h` (not necessarily percentages — pass
 * the real target aspect ratio so tile "squareness" is judged correctly, then convert the
 * returned rects to CSS percentages against that same `w`/`h`).
 */
export function squarify(values: number[], x: number, y: number, w: number, h: number): TreemapRect[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [{ x, y, w, h }];

  const results: TreemapRect[] = new Array(n);
  let remaining = values.map((v, i) => i);
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  let row: number[] = [];
  let rowIdx: number[] = [];

  const flushRow = () => {
    if (row.length === 0) return;
    const spanIsWidth = rw <= rh;
    const length = spanIsWidth ? rw : rh;
    const rects = layoutRow(row, length, rx, ry, spanIsWidth);
    rowIdx.forEach((idx, i) => {
      results[idx] = rects[i]!;
    });
    const rowSum = row.reduce((a, b) => a + b, 0);
    const thickness = length > 0 ? rowSum / length : 0;
    if (spanIsWidth) {
      ry += thickness;
      rh -= thickness;
    } else {
      rx += thickness;
      rw -= thickness;
    }
    row = [];
    rowIdx = [];
  };

  while (remaining.length > 0) {
    const spanIsWidth = rw <= rh;
    const length = spanIsWidth ? rw : rh;
    const nextIdx = remaining[0]!;
    const next = values[nextIdx]!;
    const candidateRow = [...row, next];

    if (row.length === 0 || worstRatio(candidateRow, length) <= worstRatio(row, length)) {
      row = candidateRow;
      rowIdx = [...rowIdx, nextIdx];
      remaining = remaining.slice(1);
    } else {
      flushRow();
    }
  }
  flushRow();
  return results;
}
