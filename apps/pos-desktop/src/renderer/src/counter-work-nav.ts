/** Built-in roles seeded with `terminal.execute` (apps/api permission-catalog). */
const TERMINAL_EXECUTE_ROLES = new Set([
  "owner",
  "manager",
  "pharmacist",
  "cashier",
  "inventory_clerk",
]);

/** Whether Counter work belongs on the nav rail for this branch role (epic #103). */
export function showCounterWorkNav(role: string | null | undefined): boolean {
  return role != null && TERMINAL_EXECUTE_ROLES.has(role);
}

/** Nav visibility: role grant, waiting work, or already on Counter work (PR #170). */
export function showCounterWorkRail(
  role: string | null | undefined,
  workCount: number,
  page: string,
): boolean {
  return showCounterWorkNav(role) || workCount > 0 || page === "work";
}

/** Leave Counter work when the caller lacks grant and has nothing waiting (not while `page === "work"` alone). */
export function shouldRedirectFromWorkPage(
  role: string | null | undefined,
  workCount: number,
): boolean {
  return !showCounterWorkNav(role) && workCount <= 0;
}
