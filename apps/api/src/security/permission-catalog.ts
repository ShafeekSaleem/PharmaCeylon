import { RoleName } from "@prisma/client";

/**
 * Canonical permission catalog for the configurable RBAC system.
 *
 * This is the single source of truth for:
 *  - the global `Permission` rows seeded into the database (see prisma/seed.ts)
 *  - the default `RolePermission` grants seeded for the 6 built-in roles
 *  - the guard's fallback permission set when a `UserBranchRole` has no
 *    `roleId` yet (legacy rows, or a Role row hasn't been seeded for the
 *    tenant) — see `PermissionsService.resolve()`
 *
 * Every entry's `defaultRoles` reproduces exactly the `@Roles(...)` set the
 * corresponding endpoint(s) previously used, so switching the guard over to
 * permission checks is a zero-behavior-change migration for the 6 built-in
 * roles. Custom roles created later simply pick permissions from this list.
 */
/**
 * Elevated: can change money/stock state in a way that's hard to reverse
 * (approvals, void, delete, bulk actions). Sensitive: governs access/security
 * itself (who can do what) or regulated dispensing. Deliberately sparse —
 * most permissions carry no risk label at all.
 */
export type PermissionRiskLevel = "elevated" | "sensitive";

export type PermissionDefinition = {
  key: string;
  module: string;
  label: string;
  description: string;
  /** Built-in roles granted this permission by default at seed time. */
  defaultRoles: RoleName[];
  riskLevel?: PermissionRiskLevel;
  /**
   * Permission keys this one presupposes (e.g. an approve action needs the
   * matching view). Purely additive metadata — nothing enforces this
   * server-side yet; the Roles & Permissions editor uses it client-side to
   * auto-grant prerequisites and warn before revoking one a granted
   * permission still depends on. Safe to leave empty for any entry.
   */
  dependencies?: string[];
};

/**
 * Groups the catalog's ~19 fine-grained `module` slugs (several with just
 * one permission — e.g. `roles`, `audit`, `nmra`) into a smaller set of
 * page/context-sized sections for the Roles & Permissions editor, so the
 * group list reads like the app's own pages rather than every internal
 * module getting its own single-item accordion. Purely a presentation
 * grouping — `module` on each `PermissionDefinition` stays the real,
 * fine-grained domain tag; nothing else keys off `section`.
 */
export const MODULE_SECTIONS: Record<string, string> = {
  users: "staff_access",
  roles: "staff_access",
  audit: "staff_access",
  tenant: "staff_access",
  sales: "pos_sales",
  catalog: "catalog_products",
  products: "catalog_products",
  nmra: "catalog_products",
  uploads: "catalog_products",
  customers: "customers_prescriptions",
  prescriptions: "customers_prescriptions",
  inventory: "inventory_stocktakes",
  stocktakes: "inventory_stocktakes",
  purchasing: "purchasing_suppliers",
  suppliers: "purchasing_suppliers",
  transfers: "transfers",
  returns: "returns",
  reports: "reports_analytics",
  analytics: "reports_analytics",
};

export const SECTION_LABELS: Record<string, string> = {
  staff_access: "Staff & Access",
  pos_sales: "POS & Sales",
  catalog_products: "Catalog & Products",
  customers_prescriptions: "Customers & Prescriptions",
  inventory_stocktakes: "Inventory & Stocktakes",
  purchasing_suppliers: "Purchasing & Suppliers",
  transfers: "Transfers",
  returns: "Returns",
  reports_analytics: "Reports & Analytics",
};

const { owner, manager, pharmacist, cashier, inventory_clerk } = RoleName;

export const PERMISSION_CATALOG: PermissionDefinition[] = [
  // ── Staff / users ──
  {
    key: "users.view",
    module: "users",
    label: "View staff list",
    description: "See the staff directory, roles, and branch assignments.",
    defaultRoles: [owner, manager],
  },
  {
    key: "users.create",
    module: "users",
    label: "Add staff",
    description: "Create new staff accounts.",
    defaultRoles: [owner],
    riskLevel: "sensitive",
    dependencies: ["users.view"],
  },
  {
    key: "users.manage",
    module: "users",
    label: "Manage staff",
    description:
      "Edit, deactivate/reactivate, delete, assign roles, reset till PIN, and force-logout staff.",
    defaultRoles: [owner, manager],
    riskLevel: "sensitive",
    dependencies: ["users.view"],
  },

  // ── Roles & permissions (this feature's own admin surface) ──
  {
    key: "roles.manage",
    module: "roles",
    label: "Manage roles & permissions",
    description: "Create custom roles and configure permissions per role.",
    defaultRoles: [owner, manager],
    riskLevel: "sensitive",
  },

  // ── Analytics ──
  {
    key: "analytics.view",
    module: "analytics",
    label: "View analytics",
    description: "Reorder recommendations, forecasts, branch performance, financials, sales pulse.",
    defaultRoles: [owner, manager],
  },
  {
    key: "analytics.view_footfall",
    module: "analytics",
    label: "View footfall & customer breakdown",
    description: "Store footfall and customer-mix analytics.",
    defaultRoles: [owner, manager, cashier],
  },
  {
    key: "analytics.view_supplier",
    module: "analytics",
    label: "View supplier & stock-movement analytics",
    description: "Supplier spend summaries and stock movement trends.",
    defaultRoles: [owner, manager, inventory_clerk],
  },
  {
    key: "analytics.manage_targets",
    module: "analytics",
    label: "Set branch targets",
    description: "Set monthly branch performance targets.",
    defaultRoles: [owner],
    dependencies: ["analytics.view"],
  },

  // ── Audit ──
  {
    key: "audit.view",
    module: "audit",
    label: "View audit log",
    description: "See the tenant's audit event history.",
    defaultRoles: [owner, manager],
  },

  // ── Catalog ──
  {
    key: "catalog.view",
    module: "catalog",
    label: "Browse catalog",
    description: "Search products/facets in the shared catalog.",
    defaultRoles: [owner, manager, pharmacist, cashier, inventory_clerk],
  },

  // ── Customers ──
  {
    key: "customers.view",
    module: "customers",
    label: "View customers",
    description: "See the customer directory and profiles.",
    defaultRoles: [owner, manager, pharmacist, cashier],
  },
  {
    key: "customers.create",
    module: "customers",
    label: "Add customers",
    description: "Create new customer records.",
    defaultRoles: [owner, manager, pharmacist, cashier],
  },
  {
    key: "customers.manage",
    module: "customers",
    label: "Edit customers",
    description:
      "Correct customer details and deactivate records. Separate from adding, so counter staff can register a walk-in without being able to rewrite an existing profile.",
    defaultRoles: [owner, manager, pharmacist],
  },

  // ── Prescriptions ──
  {
    key: "prescriptions.view",
    module: "prescriptions",
    label: "View prescriptions",
    description: "See customer prescription records.",
    defaultRoles: [owner, manager, pharmacist, cashier],
  },
  {
    key: "prescriptions.create",
    module: "prescriptions",
    label: "Add prescriptions",
    description: "Record new prescriptions for a customer.",
    defaultRoles: [owner, manager, pharmacist],
  },

  // ── Inventory ──
  {
    key: "inventory.view",
    module: "inventory",
    label: "View inventory",
    description: "Batches, stock levels, summaries, and stock movements.",
    defaultRoles: [owner, manager, pharmacist, cashier, inventory_clerk],
  },
  {
    key: "inventory.manage",
    module: "inventory",
    label: "Manage inventory",
    description: "Add stock to a batch (found or opening stock) and confirm imported expiry dates.",
    defaultRoles: [owner, manager, inventory_clerk],
    riskLevel: "elevated",
    dependencies: ["inventory.view"],
  },
  {
    key: "inventory.write_off",
    module: "inventory",
    label: "Write off stock",
    description: "Decrease stock on a batch: damage, loss, expiry write-off or a negative correction.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["inventory.view"],
  },
  {
    key: "inventory.quarantine",
    module: "inventory",
    label: "Quarantine stock",
    description:
      "Hold units back from sale and transfer — expired, damaged, recalled or awaiting inspection.",
    defaultRoles: [owner, manager, pharmacist, inventory_clerk],
    dependencies: ["inventory.view"],
  },
  {
    key: "inventory.release_quarantine",
    module: "inventory",
    label: "Release quarantined stock",
    description: "Return held units to sellable stock after inspection.",
    defaultRoles: [owner, manager, pharmacist],
    riskLevel: "elevated",
    dependencies: ["inventory.view"],
  },
  {
    key: "inventory.manage_bulk",
    module: "inventory",
    label: "Bulk inventory actions",
    description: "Quarantine all expired stock at the branch in one action.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["inventory.view"],
  },
  {
    key: "inventory.view_cost",
    module: "inventory",
    label: "View cost and stock value",
    description:
      "Batch cost prices and stock valuation in Inventory. Without it the API leaves them out entirely.",
    defaultRoles: [owner, manager],
    riskLevel: "sensitive",
    dependencies: ["inventory.view"],
  },

  // ── NMRA import ──
  {
    key: "nmra.import",
    module: "nmra",
    label: "Import NMRA catalog",
    description: "Preview and import the National Medicines Regulatory Authority product catalog.",
    defaultRoles: [owner, manager, inventory_clerk],
  },

  // ── Products ──
  {
    key: "products.view",
    module: "products",
    label: "View products",
    description: "Browse and export the product catalog.",
    defaultRoles: [owner, manager, pharmacist, cashier, inventory_clerk],
  },
  {
    key: "products.manage",
    module: "products",
    label: "Manage products",
    description: "Create and edit products.",
    defaultRoles: [owner, manager, inventory_clerk],
    dependencies: ["products.view"],
  },
  {
    key: "products.import",
    module: "products",
    label: "Import products",
    description:
      "Upload a product list from another system, with optional opening stock.",
    defaultRoles: [owner, manager, inventory_clerk],
    riskLevel: "elevated",
    dependencies: ["products.manage"],
  },
  {
    key: "products.delete",
    module: "products",
    label: "Delete products",
    description: "Remove products from the catalog.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["products.manage"],
  },

  // ── Product metadata (categories/tags/aliases) ──
  {
    key: "product_meta.view",
    module: "products",
    label: "View categories, tags & aliases",
    description: "See product categories, tags, and NMRA aliases.",
    defaultRoles: [owner, manager, pharmacist, cashier, inventory_clerk],
  },
  {
    key: "product_meta.manage",
    module: "products",
    label: "Manage categories, tags & aliases",
    description: "Create/edit categories, tags, and product aliases.",
    defaultRoles: [owner, manager, inventory_clerk],
    dependencies: ["product_meta.view"],
  },
  {
    key: "product_meta.delete",
    module: "products",
    label: "Delete categories & tags",
    description: "Remove categories and tags.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["product_meta.manage"],
  },

  // ── Purchasing ──
  {
    key: "purchasing.view",
    module: "purchasing",
    label: "View purchase orders",
    description: "See purchase orders and their detail.",
    defaultRoles: [owner, manager, inventory_clerk, pharmacist],
  },
  {
    key: "purchasing.manage",
    module: "purchasing",
    label: "Manage purchase orders",
    description: "Create, issue and edit purchase orders.",
    defaultRoles: [owner, manager, inventory_clerk],
    dependencies: ["purchasing.view"],
  },
  {
    key: "purchasing.receive",
    module: "purchasing",
    label: "Receive deliveries",
    description:
      "Book goods in against a purchase order, including free goods and damaged units.",
    defaultRoles: [owner, manager, inventory_clerk],
    dependencies: ["purchasing.view"],
  },
  {
    key: "purchasing.invoice",
    module: "purchasing",
    label: "Record supplier invoices",
    description:
      "Enter the supplier's own invoice, match it to deliveries, raise and void debit notes.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["purchasing.view"],
  },
  {
    key: "purchasing.view_cost",
    module: "purchasing",
    label: "View purchase costs",
    description: "Unit costs, order values and supplier price lists in Purchasing.",
    defaultRoles: [owner, manager, inventory_clerk, pharmacist],
    dependencies: ["purchasing.view"],
  },
  {
    key: "purchasing.approve",
    module: "purchasing",
    label: "Approve purchase orders",
    description: "Approve, reject, short-close, or cancel purchase orders.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["purchasing.view"],
  },

  // ── Reports ──
  {
    key: "reports.view",
    module: "reports",
    label: "View reports",
    description: "Sales summary, margin, near-expiry, and dead-stock reports.",
    defaultRoles: [owner, manager],
  },

  // ── Returns ──
  {
    key: "returns.view",
    module: "returns",
    label: "View returns",
    description: "See supplier return requests.",
    defaultRoles: [owner, manager, pharmacist, inventory_clerk, cashier],
  },
  {
    key: "returns.create",
    module: "returns",
    label: "Create returns",
    description: "Start a new supplier return request.",
    defaultRoles: [owner, manager, pharmacist, inventory_clerk],
    dependencies: ["returns.view"],
  },
  {
    key: "returns.process",
    module: "returns",
    label: "Process returns",
    description: "Submit, mark in-transit, complete, or cancel a return.",
    defaultRoles: [owner, manager, pharmacist, inventory_clerk],
    dependencies: ["returns.create"],
  },
  {
    key: "returns.approve",
    module: "returns",
    label: "Approve returns",
    description: "Approve or reject a supplier return request.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["returns.view"],
  },

  // ── Sales / POS ──
  {
    key: "sales.pos_use",
    module: "sales",
    label: "Use POS",
    description: "Ring up sales, hold/recall sales, checkout, and refund at the POS screen.",
    defaultRoles: [owner, manager, pharmacist, cashier],
  },
  {
    key: "sales.pos_pin_manage",
    module: "sales",
    label: "Set own till PIN",
    description: "Set or clear their own POS approver PIN.",
    defaultRoles: [owner, manager, pharmacist],
  },
  {
    key: "sales.void",
    module: "sales",
    label: "Void sales",
    description: "Void a completed sale.",
    defaultRoles: [owner, manager, pharmacist],
    riskLevel: "elevated",
    dependencies: ["sales.pos_use"],
  },
  {
    key: "sales.view",
    module: "sales",
    label: "View sales history",
    description: "Browse the sales/invoice list.",
    defaultRoles: [owner, manager, pharmacist, inventory_clerk, cashier],
  },
  {
    key: "sales.approve_controlled",
    module: "sales",
    label: "Approve controlled substance sales",
    description: "Co-sign POS checkouts containing controlled products (till-PIN approval).",
    defaultRoles: [owner, manager, pharmacist],
    riskLevel: "sensitive",
    dependencies: ["sales.pos_use"],
  },

  // ── Stocktakes ──
  {
    key: "stocktakes.use",
    module: "stocktakes",
    label: "Run stocktakes",
    description: "Create, count, and submit stocktakes.",
    defaultRoles: [owner, manager, inventory_clerk],
  },
  {
    key: "stocktakes.review",
    module: "stocktakes",
    label: "Review & approve stocktakes",
    description: "Review counts, request recounts, approve, post, complete, or cancel a stocktake.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["stocktakes.use"],
  },

  // ── Suppliers ──
  {
    key: "suppliers.view",
    module: "suppliers",
    label: "View suppliers",
    description: "See supplier records, invoices, and summaries.",
    defaultRoles: [owner, manager, inventory_clerk, pharmacist],
  },
  {
    key: "suppliers.manage",
    module: "suppliers",
    label: "Manage suppliers",
    description: "Create/edit suppliers, invoices, and payments.",
    defaultRoles: [owner, manager, inventory_clerk],
    dependencies: ["suppliers.view"],
  },
  {
    key: "suppliers.pay",
    module: "suppliers",
    label: "Record supplier payments",
    description:
      "Record money paid to a supplier, allocate it across their invoices, and apply debit notes.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["suppliers.view"],
  },
  {
    key: "suppliers.manage_prices",
    module: "suppliers",
    label: "Agree supplier prices",
    description:
      "See and change a supplier's price list. Agreeing what a supplier charges is a commercial decision, so it is separate from managing the supplier record.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["suppliers.view"],
  },

  // ── Tenant / branches ──
  {
    key: "tenant.branches_view",
    module: "tenant",
    label: "View branches",
    description: "See the tenant's branch list.",
    defaultRoles: [owner, manager, pharmacist, cashier, inventory_clerk],
  },
  {
    key: "tenant.branches_create",
    module: "tenant",
    label: "Create branches",
    description: "Add new branch locations to the tenant.",
    defaultRoles: [owner],
    riskLevel: "sensitive",
    dependencies: ["tenant.branches_view"],
  },
  {
    key: "tenant.branches_manage",
    module: "tenant",
    label: "Manage branches",
    description:
      "Edit branch details. Managers may only edit a branch where they hold the manager role, and cannot rename/recode it, change its timezone, or activate/deactivate it — those require tenant.branches_create-level (owner) access.",
    defaultRoles: [owner, manager],
    dependencies: ["tenant.branches_view"],
  },
  {
    key: "tenant.profile_manage",
    module: "tenant",
    label: "Edit tenant profile",
    description: "Change the tenant's legal identity, compliance, and operating defaults.",
    defaultRoles: [owner],
    riskLevel: "sensitive",
  },
  {
    key: "tenant.approval_rules",
    module: "tenant",
    label: "Change who may approve their own requests",
    description:
      "Decide which roles may approve requests they raised themselves (Settings → Approval Rules). Owner-only by default: a manager who can grant it to their own role is not being held to it.",
    defaultRoles: [owner],
    riskLevel: "sensitive",
  },
  {
    key: "tenant.management",
    module: "tenant",
    label: "Tenant management",
    description:
      "Access tenant-level module defaults (Main, Catalog, Operations, Alerts & Approvals, Insights) and the shared password/security policy.",
    defaultRoles: [owner, manager],
    riskLevel: "sensitive",
  },

  // ── Transfers ──
  {
    key: "transfers.view",
    module: "transfers",
    label: "View transfers",
    description: "See stock transfer requests between branches.",
    defaultRoles: [owner, manager, inventory_clerk, pharmacist],
  },
  {
    key: "transfers.manage",
    module: "transfers",
    label: "Manage transfers",
    description: "Create, cancel, ship, and receive stock transfers.",
    defaultRoles: [owner, manager, inventory_clerk],
    dependencies: ["transfers.view"],
  },
  {
    key: "transfers.approve",
    module: "transfers",
    label: "Approve transfers",
    description: "Approve or reject a stock transfer request.",
    defaultRoles: [owner, manager],
    riskLevel: "elevated",
    dependencies: ["transfers.view"],
  },

  // ── Uploads ──
  {
    key: "uploads.image",
    module: "uploads",
    label: "Upload images",
    description: "Upload product/attachment images.",
    defaultRoles: [owner, manager, inventory_clerk, pharmacist],
  },
];

export const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);

/** All 5 built-in roles, in display order. */
export const BUILT_IN_ROLES: RoleName[] = [
  owner,
  manager,
  pharmacist,
  cashier,
  inventory_clerk,
];

export const BUILT_IN_ROLE_LABELS: Record<RoleName, string> = {
  [owner]: "Owner",
  [manager]: "Manager",
  [pharmacist]: "Pharmacist",
  [cashier]: "Cashier",
  [inventory_clerk]: "Inventory Clerk",
  custom: "Custom",
};

/**
 * Default permission-key set for a built-in role, derived from the catalog.
 * Used both to seed `RolePermission` rows and as the guard's fallback when
 * a `UserBranchRole` row has no `roleId` (pre-migration / not-yet-seeded).
 */
export function defaultPermissionsForRole(role: RoleName): string[] {
  return PERMISSION_CATALOG.filter((p) => p.defaultRoles.includes(role)).map((p) => p.key);
}
