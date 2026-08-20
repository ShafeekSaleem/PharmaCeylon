/**
 * Fixed-order categorical palette for per-branch series (branch sales trend,
 * revenue contribution). Same teal → cyan → navy → slate family as
 * payment-mix-colors.ts for a consistent chart identity across the app.
 * Assigned by position (sorted branch order), never re-cycled per filter.
 */
const BRANCH_COLORS: string[] = [
  "var(--pc-primary)",
  "var(--pc-secondary-cyan)",
  "var(--pc-accent-navy)",
  "color-mix(in srgb, var(--pc-accent-navy) 50%, var(--pc-primary))",
  "color-mix(in srgb, var(--pc-secondary-cyan) 55%, var(--pc-muted-fg))",
  "var(--pc-muted-fg)",
];

export function branchColor(index: number): string {
  return BRANCH_COLORS[index % BRANCH_COLORS.length]!;
}
