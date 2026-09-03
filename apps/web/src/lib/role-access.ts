import type { AuthUser } from "./auth-types";

export type RoleName =
  | "owner"
  | "manager"
  | "pharmacist"
  | "cashier"
  | "inventory_clerk"
  /** Sentinel for a tenant-defined custom role — see `apps/web/src/app/(app)/users/roles/`. */
  | "custom";

export const ADMIN_ROLES: RoleName[] = ["owner", "manager"];
export const POS_ROLES: RoleName[] = ["owner", "manager", "pharmacist", "cashier"];
export const CATALOG_ROLES: RoleName[] = [
  "owner",
  "manager",
  "pharmacist",
  "cashier",
  "inventory_clerk",
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
export const INSIGHTS_ROLES: RoleName[] = ["owner", "manager"];
export const INVENTORY_WRITE_ROLES: RoleName[] = ["owner", "manager", "inventory_clerk"];

const ROLE_LABELS: Record<RoleName, string> = {
  owner: "Owner",
  manager: "Manager",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  inventory_clerk: "Inventory clerk",
  custom: "Custom role",
};

/**
 * Mirrors the API's `RolesGuard` exactly: owner on *any* branch bypasses all
 * checks; otherwise roles are scoped to the currently selected branch (or all
 * branches if none is selected yet). Pass the active `branchId` so a user who
 * e.g. is `inventory_clerk` at Branch A and `cashier` at Branch B doesn't see
 * nav items / buttons enabled while viewing Branch B that the API will 403 on.
 */
export function collectUserRoles(user: AuthUser | null, branchId?: string | null): string[] {
  if (!user) return [];
  const branchRoles = user.branchRoles ?? [];
  if (branchRoles.some((br) => br.role === "owner")) return ["owner"];
  const scoped = branchId ? branchRoles.filter((br) => br.branchId === branchId) : branchRoles;
  return Array.from(new Set(scoped.map((br) => br.role)));
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
    { prefix: "/get-started", roles: ["owner"] },
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
    { prefix: "/audit", roles: ADMIN_ROLES },
    { prefix: "/users", roles: ADMIN_ROLES },
    // No blanket "/settings" entry: My Profile, Password & Login, and Appearance under
    // /settings are open to every role; the admin-only subtrees (Tenant Profile, Branches,
    // Main/Catalog/Operations, Alerts & Approvals, and the admin part of Security) each gate
    // themselves via RolePageGuard in their own layout.tsx instead — see settings-subnav.tsx.
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

