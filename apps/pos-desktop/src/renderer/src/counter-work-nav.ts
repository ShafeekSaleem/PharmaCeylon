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
