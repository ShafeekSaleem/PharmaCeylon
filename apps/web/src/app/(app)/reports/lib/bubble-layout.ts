export type BubbleLayoutInput = { id: string; x: number; y: number; r: number };
export type BubbleLayoutResult = { id: string; x: number; y: number };

/** Iteratively nudges overlapping bubbles apart — a simplified beeswarm/force-collide pass — so a
 *  dense cluster (many SKUs/suppliers with near-identical coordinates) fans out into a readable
 *  arrangement instead of stacking exactly on top of each other with only a sliver of border
 *  showing. Runs in real pixel space (the caller measures its own plot's rendered width/height),
 *  since percentage distances aren't comparable between a chart's X and Y axes once the plot isn't
 *  square — a `dx`/`dy` of "5%" is a very different number of pixels on each axis. */
export function resolveBubbleCollisions(points: BubbleLayoutInput[], width: number, height: number, iterations = 30): BubbleLayoutResult[] {
  if (points.length === 0 || width <= 0 || height <= 0) {
    return points.map((p) => ({ id: p.id, x: p.x, y: p.y }));
  }
  const pad = 2; // minimum gap left between bubble edges, px
  const nodes = points.map((p) => ({ ...p }));

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.r + b.r + pad;
        if (dist >= minDist) continue;
        moved = true;
        if (dist < 0.001) {
          // Identical (or near-identical) coordinates — nothing to push along, so pick a
          // deterministic angle (golden-angle spread keeps repeated ties from lining up in a row).
          const angle = ((i + 1) * (j + 1) * 2.399963) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }
        const overlap = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x -= ux * overlap;
        a.y -= uy * overlap;
        b.x += ux * overlap;
        b.y += uy * overlap;
      }
    }
    for (const n of nodes) {
      n.x = Math.min(width - n.r, Math.max(n.r, n.x));
      n.y = Math.min(height - n.r, Math.max(n.r, n.y));
    }
    if (!moved) break;
  }

  return nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
}
