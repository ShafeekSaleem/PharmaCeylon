import type { AuthUser } from "./auth-types";

export type RoleName =
  | "owner"
  | "manager"
  | "pharmacist"
  | "cashier"
  | "inventory_clerk"
  | "analyst";

export const ADMIN_ROLES: RoleName[] = ["owner", "manager"];
export const POS_ROLES: RoleName[] = ["owner", "manager", "pharmacist", "cashier"];
export const CATALOG_ROLES: RoleName[] = [
  "owner",
  "manager",
  "pharmacist",
  "cashier",
  "inventory_clerk",
  "analyst",
];
export const OPERATIONS_ROLES: RoleName[] = ["owner", "manager", "pharmacist", "inventory_clerk"];
export const RETURNS_ROLES: RoleName[] = [
  "owner",
  "manager",
  "pharmacist",
  "cashier",
  "inventory_clerk",
];
export const PURCHASING_ROLES: RoleName[] = ["owner", "manager", "pharmacist", "inventory_clerk"];
export const STOCKTAKE_ROLES: RoleName[] = ["owner", "manager", "inventory_clerk"];
export const INSIGHTS_ROLES: RoleName[] = ["owner", "manager", "analyst"];
export const INVENTORY_WRITE_ROLES: RoleName[] = ["owner", "manager", "inventory_clerk"];

const ROLE_LABELS: Record<RoleName, string> = {
  owner: "Owner",
  manager: "Manager",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  inventory_clerk: "Inventory clerk",
  analyst: "Analyst",
};

export function collectUserRoles(user: AuthUser | null): string[] {
  if (!user) return [];
  const roles = new Set<string>(user.roles ?? []);
  for (const br of user.branchRoles ?? []) roles.add(br.role);
  return Array.from(roles);
}

export function hasRoleAccess(
  userRoles: string[],
  allowedRoles?: RoleName[],
): boolean {
  if (!allowedRoles || allowedRoles.length === 0) return true;
  return userRoles.some((r) => allowedRoles.includes(r as RoleName));
}

export function formatAllowedRoles(roles: RoleName[]): string {
  return roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
}

/** Canonical copy for tooltips, links, and access-denied panels. */
export function roleDeniedMessage(allowedRoles?: RoleName[]): string {
  if (!allowedRoles?.length) {
    return "You don't have permission to access this.";
  }
  return `You don't have permission to access this. Available to: ${formatAllowedRoles(allowedRoles)}.`;
}

/** Longest-prefix match for route-level access (pathname without query). */
export function rolesForPath(pathname: string): RoleName[] | undefined {
  const path = pathname.split("?")[0] ?? pathname;

  const rules: { prefix: string; roles: RoleName[] | undefined }[] = [
    { prefix: "/inventory/adjustments", roles: INVENTORY_WRITE_ROLES },
    { prefix: "/inventory", roles: OPERATIONS_ROLES },
    { prefix: "/purchasing", roles: PURCHASING_ROLES },
    { prefix: "/suppliers", roles: OPERATIONS_ROLES },
    { prefix: "/transfers", roles: OPERATIONS_ROLES },
    { prefix: "/returns", roles: RETURNS_ROLES },
    { prefix: "/stocktakes", roles: STOCKTAKE_ROLES },
    { prefix: "/pos", roles: POS_ROLES },
    { prefix: "/catalog", roles: CATALOG_ROLES },
    { prefix: "/products", roles: CATALOG_ROLES },
    { prefix: "/reports", roles: INSIGHTS_ROLES },
    { prefix: "/analytics", roles: INSIGHTS_ROLES },
    { prefix: "/audit", roles: ADMIN_ROLES },
    { prefix: "/users", roles: ADMIN_ROLES },
    { prefix: "/settings", roles: ADMIN_ROLES },
  ];

  const match = rules
    .filter((r) => path === r.prefix || path.startsWith(`${r.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];

  return match?.roles;
}

export function canAccessPath(userRoles: string[], pathname: string): boolean {
  return hasRoleAccess(userRoles, rolesForPath(pathname));
}

export function rolesForHref(href: string): RoleName[] | undefined {
  const path = href.split("?")[0] ?? href;
  return rolesForPath(path);
}
