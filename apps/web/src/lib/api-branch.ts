/** Appends `branchId` as a query param when present — the shared shape every
 * self-fetching dashboard panel/widget uses to scope its own API call. */
export function withBranch(path: string, branchId: string | null | undefined): string {
  if (!branchId) return path;
  const qs = `branchId=${encodeURIComponent(branchId)}`;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}
