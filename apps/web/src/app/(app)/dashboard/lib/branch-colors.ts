/**
 * Fixed-order categorical palette for per-branch series (branch sales trend,
 * revenue contribution): the pharmacy's chart series (UI1 #205), accent family or the
 * distinct set as the owner chose, shared with payment-mix-colors.ts.
 * Assigned by position (sorted branch order), never re-cycled per filter.
 */
const BRANCH_COLORS: string[] = [
  "var(--pc-chart-1)",
  "var(--pc-chart-2)",
  "var(--pc-chart-3)",
  "var(--pc-chart-4)",
  "var(--pc-chart-5)",
  "var(--pc-chart-6)",
];

export function branchColor(index: number): string {
  return BRANCH_COLORS[index % BRANCH_COLORS.length]!;
}
