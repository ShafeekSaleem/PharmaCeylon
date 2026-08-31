"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageChrome } from "@/lib/page-chrome-context";
import { useAuth } from "@/lib/use-auth";
import { usePermissions } from "@/lib/permissions";
import {
  BRANCHES_CHANGED_EVENT,
  fetchTenantBranches,
  fetchTenantDisplayName,
  type TenantBranch,
} from "@/lib/auth-client";
import { GlobalSearch } from "@/components/global-search/global-search";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { AppearanceEffect } from "./appearance-effect";
import {
  IconGrid,
  IconShoppingCart,
  IconPackage,
  IconBox,
  IconClipboardList,
  IconTruck,
  IconRefresh,
  IconBarChart,
  IconFileText,
  IconUsers,
  IconSettings,
  IconSearch,
  IconMenu,
  IconLogOut,
  IconUser,
  IconChevronDown,
  IconChevronRight,
  IconClipboard,
} from "@/components/icons";
import styles from "./app-shell.module.css";
import {
  ADMIN_ROLES,
  CATALOG_ROLES,
  INSIGHTS_ROLES,
  OPERATIONS_ROLES,
  POS_ROLES,
  PURCHASING_ROLES,
  RETURNS_ROLES,
  STOCKTAKE_ROLES,
  collectUserRoles,
  hasRoleAccess,
  roleDeniedMessage,
  type RoleName,
} from "@/lib/role-access";

type NavEntry = {
  href: string;
  label: string;
  icon: React.ReactNode;
  roles?: RoleName[];
  /**
   * Preferred over `roles` when present — matches the `permissions` prop the destination
   * page's own `RolePageGuard` actually gates on (see each domain's layout.tsx). A tenant's
   * custom role can be granted this permission without being one of the static `roles`, so
   * checking `roles` alone can show the nav item as restricted even though the page itself
   * would let the user in. `roles` is kept only as the source for the denied-tooltip copy.
   */
  permission?: string;
};

type NavGroup = { label: string; items: NavEntry[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Main",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: <IconGrid size={18} /> },
      { href: "/pos", label: "POS / Checkout", icon: <IconShoppingCart size={18} />, roles: POS_ROLES, permission: "sales.pos_use" },
    ],
  },
  {
    label: "Catalog",
    items: [
      { href: "/products", label: "Products", icon: <IconPackage size={18} />, roles: CATALOG_ROLES, permission: "products.view" },
      { href: "/catalog", label: "Search Catalog", icon: <IconSearch size={18} />, roles: CATALOG_ROLES, permission: "catalog.view" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/inventory", label: "Inventory", icon: <IconBox size={18} />, roles: OPERATIONS_ROLES, permission: "inventory.view" },
      { href: "/purchasing", label: "Purchasing", icon: <IconClipboardList size={18} />, roles: PURCHASING_ROLES, permission: "purchasing.view" },
      { href: "/suppliers", label: "Suppliers", icon: <IconUsers size={18} />, roles: OPERATIONS_ROLES, permission: "suppliers.view" },
      { href: "/transfers", label: "Transfers", icon: <IconTruck size={18} />, roles: OPERATIONS_ROLES, permission: "transfers.view" },
      { href: "/returns", label: "Returns", icon: <IconRefresh size={18} />, roles: RETURNS_ROLES, permission: "returns.view" },
      { href: "/stocktakes", label: "Stocktakes", icon: <IconClipboard size={18} />, roles: STOCKTAKE_ROLES, permission: "stocktakes.use" },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/reports", label: "Reports", icon: <IconBarChart size={18} />, roles: INSIGHTS_ROLES, permission: "reports.view" },
      { href: "/audit", label: "Audit Log", icon: <IconFileText size={18} />, roles: ADMIN_ROLES, permission: "audit.view" },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/users", label: "Users & Roles", icon: <IconUsers size={18} />, roles: ADMIN_ROLES, permission: "users.view" },
      // Open to every role — My Profile/Password & Login/Appearance live under here too;
      // the admin-only subtrees self-gate in their own layout.tsx (see settings-subnav.tsx).
      { href: "/settings", label: "Settings", icon: <IconSettings size={18} /> },
    ],
  },
];

const PAGE_TITLES: Record<string, string> = {};
for (const g of NAV_GROUPS) {
  for (const item of g.items) {
    PAGE_TITLES[item.href] = item.label;
  }
}
PAGE_TITLES["/inventory/batches"] = "Batch stock";
PAGE_TITLES["/inventory/adjustments"] = "Stock adjustments";
PAGE_TITLES["/inventory/movements"] = "Stock movements";
PAGE_TITLES["/notifications"] = "Notifications";
PAGE_TITLES["/settings/my-profile"] = "My Profile";
PAGE_TITLES["/settings/tenant-profile"] = "Organization Profile";
PAGE_TITLES["/settings/branches"] = "Branches";
PAGE_TITLES["/settings/main"] = "Point of Sale & Receipts";
PAGE_TITLES["/settings/catalog"] = "Catalog";
PAGE_TITLES["/settings/operations"] = "Inventory & Operations";
PAGE_TITLES["/settings/alerts-recipients"] = "Recipients & Channels";
PAGE_TITLES["/settings/notifications"] = "Notifications";
PAGE_TITLES["/settings/approval-rules"] = "Approval Rules";
PAGE_TITLES["/settings/insights-reports"] = "Reports";
PAGE_TITLES["/settings/password-login"] = "Password & Security";
PAGE_TITLES["/settings/appearance"] = "Appearance";

const COLLAPSE_KEY = "pc_sidebar_collapsed";

function getInitials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function navItemAllowed(item: NavEntry, userRoles: string[], permissionKeys: string[]): boolean {
  if (item.permission) return permissionKeys.includes(item.permission);
  return hasRoleAccess(userRoles, item.roles);
}

function resolvePageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  // Prefer longest matching path (e.g. /inventory/batches over /inventory)
  const match = Object.keys(PAGE_TITLES)
    .filter((key) => pathname === key || pathname.startsWith(key + "/"))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PAGE_TITLES[match] : "Page";
}

function buildBreadcrumbs(
  pathname: string,
  lastSegmentLabel?: string | null,
): { label: string; href?: string }[] {
  const navBases = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)));
  const base = [...navBases].find((k) => pathname === k || pathname.startsWith(k + "/"));
  if (!base) return [{ label: resolvePageTitle(pathname) }];

  const crumbs: { label: string; href?: string }[] = [{ label: PAGE_TITLES[base], href: base }];
  const rest = pathname.slice(base.length).replace(/^\//, "");
  if (rest) {
    const segments = rest.split("/").filter(Boolean);
    let path = base;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      path += `/${seg}`;
      const isLast = i === segments.length - 1;
      const known = PAGE_TITLES[path];
      const label =
        isLast && lastSegmentLabel ? lastSegmentLabel : known ?? seg.replace(/-/g, " ");
      crumbs.push(isLast ? { label } : { label, href: path });
    }
  }
  if (crumbs.length === 1) delete crumbs[0].href;
  return crumbs;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, ready, isAuthenticated, branchId, setBranchId, logout } = useAuth();
  const { permissionKeys } = usePermissions();
  const { extraCrumbs, lastSegmentLabel } = usePageChrome();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const [tenantName, setTenantName] = useState<string | null>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setCollapsed(readCollapsed()); }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!isAuthenticated) router.replace("/login");
  }, [ready, isAuthenticated, router]);

  const loadBranches = useCallback(() => {
    if (!ready || !isAuthenticated) return () => {};
    let cancelled = false;
    fetchTenantBranches()
      .then((b) => { if (!cancelled) setBranches(b); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ready, isAuthenticated]);

  useEffect(() => loadBranches(), [loadBranches]);

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    let cancelled = false;
    fetchTenantDisplayName()
      .then((name) => { if (!cancelled) setTenantName(name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ready, isAuthenticated]);

  useEffect(() => {
    const refresh = () => { loadBranches(); };
    window.addEventListener(BRANCHES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(BRANCHES_CHANGED_EVENT, refresh);
  }, [loadBranches]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setAvatarOpen(false);
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) setBranchOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && e.code === "KeyP" && permissionKeys.includes("sales.pos_use")) {
        e.preventDefault();
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        router.push("/pos");
        return;
      }
      if (ctrl && e.code === "KeyB") {
        e.preventDefault();
        toggleCollapsed();
        return;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggleCollapsed, router, permissionKeys]);

  const handleLogout = useCallback(async () => {
    setAvatarOpen(false);
    await logout();
    router.push("/login");
  }, [logout, router]);

  const userRoles = useMemo(() => collectUserRoles(user, branchId), [user, branchId]);
  const canUsePos = permissionKeys.includes("sales.pos_use");
  const quickSaleHidden =
    pathname === "/pos" ||
    pathname.startsWith("/pos/") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/users") ||
    pathname.startsWith("/audit") ||
    pathname.startsWith("/notifications");

  const navGroups = NAV_GROUPS;

  if (!ready || !isAuthenticated) {
    return (
      <div className={styles.loadingShell}>
        <div className={styles.loadingSpinner} />
      </div>
    );
  }

  const currentBranch = branches.find((b) => b.id === branchId);
  const branchName = currentBranch?.name ?? "Select Branch";
  const pageTitle = resolvePageTitle(pathname);
  const breadcrumbs = [...buildBreadcrumbs(pathname, lastSegmentLabel), ...extraCrumbs];
  const initials = user ? getInitials(user.fullName) : "??";
  const isSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  // Owner/manager settings reach tenant-wide (or, for a manager, several branches they
  // manage) — show the tenant name. Every other role's settings are personal or scoped to
  // their one branch, so the branch name reads more accurately there.
  const settingsScopedToTenant =
    user?.branchRoles.some((br) => br.role === "owner" || br.role === "manager") ?? false;

  const sidebarCls = [
    styles.sidebar,
    collapsed ? styles.sidebarCollapsed : "",
    mobileOpen ? styles.sidebarOpen : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={styles.shell}>
      <AppearanceEffect />
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div className={styles.backdrop} onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={sidebarCls}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarLogo}>
            <svg width="20" height="20" viewBox="0 0 48 48" fill="none" aria-hidden>
              <rect x="8" y="12" width="28" height="22" rx="3" stroke="white" strokeWidth="3" />
              <path d="M16 12V9a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" stroke="white" strokeWidth="3" strokeLinecap="round" />
              <path d="M24 22v8M20 26h8" stroke="white" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>
          {!collapsed && <span className={styles.sidebarBrand}>PharmaCeylon</span>}
        </div>

        <nav className={styles.sidebarNav}>
          {navGroups.map((group) => (
            <div key={group.label} className={styles.navGroup}>
              <span className={styles.navGroupLabel}>{group.label}</span>
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + "/");
                const allowed = navItemAllowed(item, userRoles, permissionKeys);
                const deniedTip = roleDeniedMessage(item.roles);

                if (!allowed) {
                  return (
                    <span
                      key={item.href}
                      className={`${styles.navItem} ${styles.navItemRestricted}`}
                      aria-disabled="true"
                      data-tooltip={deniedTip}
                      data-tooltip-placement="right"
                    >
                      <span className={styles.navItemIcon}>{item.icon}</span>
                      <span className={styles.navItemLabel}>{item.label}</span>
                    </span>
                  );
                }

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.navItem}${active ? ` ${styles.navItemActive}` : ""}`}
                    onClick={() => setMobileOpen(false)}
                    {...(collapsed
                      ? {
                          "data-tooltip": item.label,
                          "data-tooltip-placement": "right",
                        }
                      : {})}
                  >
                    <span className={styles.navItemIcon}>{item.icon}</span>
                    <span className={styles.navItemLabel}>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>Version 1.0.0</div>
      </aside>

      {/* Main */}
      <div className={`${styles.main}${collapsed ? ` ${styles.mainCollapsed}` : ""}`}>
        {/* Top bar */}
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.menuBtn}
            onClick={() => {
              if (window.innerWidth <= 768) setMobileOpen((v) => !v);
              else toggleCollapsed();
            }}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <IconMenu size={20} />
          </button>
          <span className={styles.pageTitle}>{pageTitle}</span>

          <GlobalSearch permissionKeys={permissionKeys} />

          <div className={styles.topbarRight}>
            <NotificationCenter />

            {/* Avatar */}
            <div className={styles.avatarWrap} ref={avatarRef}>
              <button
                type="button"
                className={styles.avatarBtn}
                onClick={() => setAvatarOpen((v) => !v)}
                aria-label="User menu"
              >
                {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials}
              </button>
              {avatarOpen && (
                <div className={styles.avatarMenu}>
                  <div className={styles.avatarMenuHeader}>
                    <div className={styles.avatarMenuName}>{user?.fullName}</div>
                    <div className={styles.avatarMenuEmail}>{user?.email}</div>
                  </div>
                  <div className={styles.avatarMenuBody}>
                    <button
                      type="button"
                      className={styles.avatarMenuItem}
                      onClick={() => { setAvatarOpen(false); router.push("/settings/my-profile"); }}
                    >
                      <IconUser size={16} /> Profile
                    </button>
                    <div className={styles.avatarMenuDivider} />
                    <button type="button" className={styles.avatarMenuItem} onClick={handleLogout}>
                      <IconLogOut size={16} /> Logout
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Sub-header */}
        <div className={styles.subheader}>
          <span className={styles.branchBadge}>
            {isSettings ? (settingsScopedToTenant ? (tenantName ?? "Tenant") : branchName) : branchName}
          </span>
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className={styles.breadcrumbSegment}>
              <IconChevronRight size={12} />
              {crumb.href ? (
                <Link href={crumb.href} className={styles.breadcrumbLink}>{crumb.label}</Link>
              ) : (
                <span className={styles.breadcrumbPage}>{crumb.label}</span>
              )}
            </span>
          ))}

          {!isSettings && <div className={styles.subheaderRight}>
            <span className={styles.branchLabel}>Switch branch</span>
            <div className={styles.branchDropWrap} ref={branchRef}>
              <button
                type="button"
                className={styles.branchDropBtn}
                onClick={() => setBranchOpen((v) => !v)}
              >
                <span>{branchName}</span>
                <IconChevronDown size={14} />
              </button>
              {branchOpen && (
                <div className={styles.branchDropMenu}>
                  {branches.length === 0 && (
                    <div className={styles.branchDropItem} style={{ color: "var(--pc-muted-fg)" }}>
                      Loading...
                    </div>
                  )}
                  {branches.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className={`${styles.branchDropItem}${b.id === branchId ? ` ${styles.branchDropItemActive}` : ""}`}
                      onClick={() => { setBranchId(b.id); setBranchOpen(false); }}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>}
        </div>

        {/* Page content */}
        <main className={styles.content}>{children}</main>
      </div>

      {/* Permission-aware, context-sensitive Quick Sale launcher. */}
      {canUsePos && !quickSaleHidden && (
        <Link href="/pos" className={styles.fab} aria-label="Start a new sale (Ctrl+Shift+P)">
          <IconShoppingCart size={24} />
          <span>New Sale</span>
        </Link>
      )}

    </div>
  );
}
