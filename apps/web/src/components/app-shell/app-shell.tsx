"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageChrome } from "@/lib/page-chrome-context";
import { useAuth } from "@/lib/use-auth";
import { BRANCHES_CHANGED_EVENT, fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
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
  IconBell,
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
};

type NavGroup = { label: string; items: NavEntry[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Main",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: <IconGrid size={18} /> },
      { href: "/pos", label: "POS / Checkout", icon: <IconShoppingCart size={18} />, roles: POS_ROLES },
    ],
  },
  {
    label: "Catalog",
    items: [
      { href: "/products", label: "Products", icon: <IconPackage size={18} />, roles: CATALOG_ROLES },
      { href: "/catalog", label: "Search Catalog", icon: <IconSearch size={18} />, roles: CATALOG_ROLES },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/inventory", label: "Inventory", icon: <IconBox size={18} />, roles: OPERATIONS_ROLES },
      { href: "/purchasing", label: "Purchasing", icon: <IconClipboardList size={18} />, roles: PURCHASING_ROLES },
      { href: "/suppliers", label: "Suppliers", icon: <IconUsers size={18} />, roles: OPERATIONS_ROLES },
      { href: "/transfers", label: "Transfers", icon: <IconTruck size={18} />, roles: OPERATIONS_ROLES },
      { href: "/returns", label: "Returns", icon: <IconRefresh size={18} />, roles: RETURNS_ROLES },
      { href: "/stocktakes", label: "Stocktakes", icon: <IconClipboard size={18} />, roles: STOCKTAKE_ROLES },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/reports", label: "Reports", icon: <IconBarChart size={18} />, roles: INSIGHTS_ROLES },
      { href: "/audit", label: "Audit Log", icon: <IconFileText size={18} />, roles: ADMIN_ROLES },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/users", label: "Users & Roles", icon: <IconUsers size={18} />, roles: ADMIN_ROLES },
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
PAGE_TITLES["/settings/my-profile"] = "My Profile";
PAGE_TITLES["/settings/tenant-profile"] = "Organization Profile";
PAGE_TITLES["/settings/branches"] = "Branches";
PAGE_TITLES["/settings/main"] = "Point of Sale & Receipts";
PAGE_TITLES["/settings/catalog"] = "Catalog";
PAGE_TITLES["/settings/operations"] = "Inventory & Operations";
PAGE_TITLES["/settings/alerts-recipients"] = "Notifications";
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

function hasAccess(userRoles: string[], allowedRoles?: RoleName[]): boolean {
  return hasRoleAccess(userRoles, allowedRoles);
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
  const { extraCrumbs, lastSegmentLabel } = usePageChrome();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const avatarRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
    const refresh = () => { loadBranches(); };
    window.addEventListener(BRANCHES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(BRANCHES_CHANGED_EVENT, refresh);
  }, [loadBranches]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setAvatarOpen(false);
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) setBranchOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        router.push("/pos");
        return;
      }
      if (ctrl && e.code === "KeyK") {
        e.preventDefault();
        searchRef.current?.focus();
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
  }, [toggleCollapsed, router]);

  const handleLogout = useCallback(async () => {
    setAvatarOpen(false);
    await logout();
    router.push("/login");
  }, [logout, router]);

  const userRoles = useMemo(() => collectUserRoles(user, branchId), [user, branchId]);

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
                const allowed = hasAccess(userRoles, item.roles);
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

          <div className={styles.searchBar}>
            <IconSearch size={16} />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search products, invoices, customers..."
              readOnly
            />
          </div>

          <div className={styles.topbarRight}>
            {/* Notifications */}
            <div className={styles.notifWrap} ref={notifRef}>
              <button
                type="button"
                className={`${styles.iconBtn}${notifOpen ? ` ${styles.iconBtnActive}` : ""}`}
                aria-label="Notifications"
                onClick={() => setNotifOpen((v) => !v)}
              >
                <IconBell size={20} />
                <span className={styles.badge}>3</span>
              </button>
              {notifOpen && (
                <div className={styles.notifMenu}>
                  <div className={styles.notifHeader}>
                    <span className={styles.notifTitle}>Notifications</span>
                    <button type="button" className={styles.notifMarkAll}>Mark all read</button>
                  </div>
                  <div className={styles.notifBody}>
                    <div className={styles.notifItem}>
                      <div className={styles.notifDot} />
                      <div>
                        <div className={styles.notifText}>5 products are running low on stock</div>
                        <div className={styles.notifTime}>2 hours ago</div>
                      </div>
                    </div>
                    <div className={styles.notifItem}>
                      <div className={styles.notifDot} />
                      <div>
                        <div className={styles.notifText}>Purchase order #PO-1042 received</div>
                        <div className={styles.notifTime}>5 hours ago</div>
                      </div>
                    </div>
                    <div className={styles.notifItem}>
                      <div className={styles.notifDot} />
                      <div>
                        <div className={styles.notifText}>3 batches expiring within 30 days</div>
                        <div className={styles.notifTime}>1 day ago</div>
                      </div>
                    </div>
                  </div>
                  <div className={styles.notifFooter}>
                    <button type="button" className={styles.notifViewAll}>View all notifications</button>
                  </div>
                </div>
              )}
            </div>

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
          {!isSettings && <span className={styles.branchBadge}>{branchName}</span>}
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

      {/* FAB — Quick POS (hidden on POS page) */}
      {pathname !== "/pos" && !isSettings && (
        <Link href="/pos" className={styles.fab} aria-label="Quick POS (Ctrl+Shift+P)">
          <IconShoppingCart size={24} />
        </Link>
      )}

    </div>
  );
}
