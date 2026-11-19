"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePageChrome } from "@/lib/page-chrome-context";
import { useAuth } from "@/lib/use-auth";
import { hasPermission, usePermissions } from "@/lib/permissions";
import { useBranchRollout, webPosHidden } from "@/lib/branch-rollout";
import { fetchSetupReadiness, SETUP_JOURNEY_CHANGED_EVENT } from "@/lib/setup-readiness-client";
import { useFullscreen } from "@/lib/use-fullscreen";
import {
  BRANCHES_CHANGED_EVENT,
  fetchTenantBranches,
  type TenantBranch,
} from "@/lib/auth-client";
import { GlobalSearch } from "@/components/global-search/global-search";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { AppearanceEffect } from "./appearance-effect";
import { PosFallbackBanner } from "./pos-fallback-banner";
import { PageTitleProvider } from "./page-title-context";
import { ThemeToggle } from "./theme-toggle";
import {
  IconGrid,
  IconShoppingCart,
  IconPackage,
  IconBox,
  IconClipboardList,
  IconTruck,
  IconBarChart,
  IconFileText,
  IconUsers,
  IconSettings,
  IconMenu,
  IconLogOut,
  IconUser,
  IconChevronDown,
  IconChevronRight,
  IconClipboard,
  IconTarget,
  IconMaximize,
  IconMinimize,
  IconReceipt,
  IconMapPin,
} from "@/components/icons";
import styles from "./app-shell.module.css";
import {
  ADMIN_ROLES,
  CATALOG_ROLES,
  INSIGHTS_ROLES,
  OPERATIONS_ROLES,
  PURCHASING_ROLES,
  SALES_ROLES,
  STOCKTAKE_ROLES,
  collectUserRoles,
  hasRoleAccess,
  roleDeniedMessage,
  type RoleName,
} from "@/lib/role-access";
import { isPersonalAccountPath, mayOpenWebPath } from "@/lib/back-office-access";
import { useFabClearance } from "./use-fab-clearance";

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
   *
   * An array means "any of these" — used where one page absorbed another's job and must stay
   * reachable by everyone who could reach either (Products, which took over Search Catalog).
   */
  permission?: string | string[];
};

type NavGroup = { label: string; items: NavEntry[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Main",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: <IconGrid size={18} /> },
      {
        href: "/get-started",
        label: "Get started",
        icon: <IconTarget size={18} />,
        roles: ["owner"],
      },
      // Gated on the permission alone: a custom role can hold `sales.pos_use` without being one
      // of the built-in till roles. Hidden at a branch where desktop POS is live (D-W1).
      {
        href: "/pos",
        label: "POS / Checkout",
        icon: <IconShoppingCart size={18} />,
        permission: "sales.pos_use",
      },
    ],
  },
  {
    // Reading sales back — history, a sale's detail, a receipt copy. Ringing them up is POS,
    // which moves to the desktop counter; this group is where the web keeps sales afterwards.
    label: "Sales",
    items: [
      {
        href: "/sales",
        label: "Sales",
        icon: <IconReceipt size={18} />,
        roles: SALES_ROLES,
        permission: ["sales.view", "returns.approve"],
      },
    ],
  },
  {
    label: "Catalog",
    items: [
      // Search Catalog used to sit here as a second entry. It searched the same reference rows
      // as Products' Reference tab, so the sidebar offered two doors into one room — and only
      // one of them could add a medicine to the range. `/catalog` now redirects here.
      // `permission` admits either key so nobody who had only `catalog.view` loses the nav item.
      {
        href: "/products",
        label: "Products",
        icon: <IconPackage size={18} />,
        roles: CATALOG_ROLES,
        permission: ["products.view", "catalog.view"],
      },
    ],
  },
  {
    // Customer and prescription records are looked up deliberately, not part of
    // the till flow — so they get their own home rather than sitting under Main
    // beside Dashboard and POS.
    label: "Dispensary",
    items: [
      {
        href: "/customers",
        label: "Customers",
        icon: <IconUser size={18} />,
        permission: "customers.view",
      },
      {
        href: "/prescriptions",
        label: "Prescriptions",
        icon: <IconFileText size={18} />,
        permission: "prescriptions.view",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/inventory",
        label: "Inventory",
        icon: <IconBox size={18} />,
        roles: OPERATIONS_ROLES,
        permission: "inventory.view",
      },
      {
        href: "/purchasing",
        label: "Purchasing",
        icon: <IconClipboardList size={18} />,
        roles: PURCHASING_ROLES,
        permission: "purchasing.view",
      },
      {
        href: "/suppliers",
        label: "Suppliers",
        icon: <IconUsers size={18} />,
        roles: OPERATIONS_ROLES,
        permission: "suppliers.view",
      },
      {
        href: "/transfers",
        label: "Transfers",
        icon: <IconTruck size={18} />,
        roles: OPERATIONS_ROLES,
        permission: "transfers.view",
      },
      {
        href: "/stocktakes",
        label: "Stocktakes",
        icon: <IconClipboard size={18} />,
        roles: STOCKTAKE_ROLES,
        permission: "stocktakes.use",
      },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        href: "/reports",
        label: "Reports",
        icon: <IconBarChart size={18} />,
        roles: INSIGHTS_ROLES,
        permission: "reports.view",
      },
      {
        href: "/audit",
        label: "Audit Log",
        icon: <IconFileText size={18} />,
        roles: ADMIN_ROLES,
        permission: "audit.view",
      },
    ],
  },
  {
    label: "Admin",
    items: [
      {
        href: "/users",
        label: "Users & Roles",
        icon: <IconUsers size={18} />,
        roles: ADMIN_ROLES,
        permission: "users.view",
      },
      // Open to every role — My Profile/Password & Login/Appearance live under here too;
      // the admin-only subtrees self-gate in their own layout.tsx (see settings-subnav.tsx).
      {
        href: "/settings",
        label: "Settings",
        icon: <IconSettings size={18} />,
      },
    ],
  },
];

const PAGE_TITLES: Record<string, string> = {};
for (const g of NAV_GROUPS) {
  for (const item of g.items) {
    PAGE_TITLES[item.href] = item.label;
  }
}
// Pages outside the sidebar, and pages below a sidebar item. The page header shows this name
// (#205: the title appears once), and a parent's name is its breadcrumb link.
Object.assign(PAGE_TITLES, {
  "/purchasing/deliveries": "Deliveries",
  "/purchasing/invoices": "Invoices",
  "/purchasing/supplier-returns": "Supplier returns",
  "/purchasing/cash-payouts": "Cash payouts",
  "/inventory/batches": "Batch stock",
  "/inventory/adjustments": "Stock adjustments",
  "/inventory/movements": "Stock movements",
  "/inventory/offline-records": "Offline records",
  "/inventory/stock-cases": "Stock cases",
  "/products/categories": "Categories",
  "/products/tags": "Tags",
  "/products/organize": "Organize products",
  "/products/nmra-matches": "NMRA matches",
  "/products/import": "Import products",
  "/products/manage": "Catalog management",
  "/returns": "Returns",
  "/refund-approvals": "Refund approvals",
  "/insights": "Insights",
  "/notifications": "Notifications",
  "/users/roles": "Roles",
  "/settings/my-profile": "My Profile",
  "/settings/tenant-profile": "Organization Profile",
  "/settings/branches": "Branches",
  "/settings/branches/hours": "Opening Hours",
  "/settings/main": "Counters & receipts",
  "/settings/counters": "Counters",
  "/settings/counter-alerts": "Counter alerts",
  "/settings/payments": "Payments",
  "/settings/offline-policy": "Offline policy",
  "/settings/catalog": "Catalog",
  "/settings/catalog/categories": "Categories",
  "/settings/catalog/tags": "Tags",
  "/settings/operations": "Operations",
  "/settings/profitability": "Profitability",
  "/settings/alerts-recipients": "Recipients & Channels",
  "/settings/notifications": "Notifications",
  "/settings/approval-rules": "Approval Rules",
  "/settings/insights-reports": "Insights & Reports",
  "/settings/password-login": "Password & Login",
  "/settings/appearance": "Appearance",
} satisfies Record<string, string>);

const COLLAPSE_KEY = "pc_sidebar_collapsed";

// Next renders client components on the server too, where a layout effect only warns.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
  if (item.permission) {
    return hasPermission(permissionKeys, [item.permission].flat());
  }
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

/** A record id in the path (a UUID or similar) — never shown as a title. */
function looksLikeId(segment: string): boolean {
  return /^[0-9a-f-]{20,}$/i.test(segment) || /^c[a-z0-9]{20,}$/i.test(segment);
}

function segmentLabel(segment: string): string {
  if (looksLikeId(segment)) return "Details";
  const words = decodeURIComponent(segment).replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function buildBreadcrumbs(
  pathname: string,
  lastSegmentLabel?: string | null,
): { label: string; href?: string }[] {
  const navBases = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)));
  const base = [...navBases].find((k) => pathname === k || pathname.startsWith(k + "/"));
  if (!base) return [{ label: lastSegmentLabel || resolvePageTitle(pathname) }];

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
      const label = isLast && lastSegmentLabel ? lastSegmentLabel : (known ?? segmentLabel(seg));
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
  const {
    permissionKeys,
    backOfficeAccess,
    accessResolved,
    loading: permissionsLoading,
  } = usePermissions();
  // The branch's web scope is only established by a current rollout answer. While the first read
  // loads, or after a read failed (a failed refresh clears the earlier answer), it is unknown and
  // the shell fails closed: no back-office page mounts, so none of its requests run either.
  const { rollout, resolved: rolloutResolved, failed: rolloutFailed } = useBranchRollout();
  const scopeRollout = rolloutResolved ? rollout : null;
  const posHidden = webPosHidden(rollout);
  const webScopeRestricted =
    !accessResolved || !scopeRollout || (scopeRollout.state !== "not_live" && !backOfficeAccess);
  const pageAllowed =
    isPersonalAccountPath(pathname) ||
    (accessResolved && mayOpenWebPath(pathname, backOfficeAccess, scopeRollout));
  const { extraCrumbs, lastSegmentLabel, chromeHidden } = usePageChrome();
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  // False while the page has drawn no <h1> of its own (no PageHeader, no hero): the shell then
  // shows the page title itself, so every page still has exactly one.
  const [pageHasHeading, setPageHasHeading] = useState(true);
  const mainRef = useRef<HTMLElement>(null);
  const [showSetupJourney, setShowSetupJourney] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {}
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
      .then((b) => {
        if (!cancelled) setBranches(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ready, isAuthenticated]);

  useEffect(() => loadBranches(), [loadBranches]);

  const loadSetupJourney = useCallback(() => {
    const isOwner = user?.branchRoles.some((entry) => entry.role === "owner") ?? false;
    if (!ready || !isAuthenticated || !branchId || !isOwner) {
      setShowSetupJourney(false);
      return () => {};
    }
    let cancelled = false;
    fetchSetupReadiness()
      .then((result) => {
        if (!cancelled) setShowSetupJourney(result.journeyEnabled);
      })
      .catch(() => {
        if (!cancelled) setShowSetupJourney(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, isAuthenticated, branchId, user]);

  useEffect(() => loadSetupJourney(), [loadSetupJourney]);

  useEffect(() => {
    const refresh = () => {
      loadSetupJourney();
    };
    window.addEventListener(SETUP_JOURNEY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SETUP_JOURNEY_CHANGED_EVENT, refresh);
  }, [loadSetupJourney]);

  useEffect(() => {
    const refresh = () => {
      loadBranches();
    };
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

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (
        ctrl &&
        e.shiftKey &&
        e.code === "KeyP" &&
        permissionKeys.includes("sales.pos_use") &&
        accessResolved &&
        !!rollout &&
        (backOfficeAccess || rollout.state !== "live") &&
        !posHidden
      ) {
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
      if (ctrl && e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    toggleCollapsed,
    router,
    permissionKeys,
    posHidden,
    toggleFullscreen,
    accessResolved,
    rollout,
    backOfficeAccess,
  ]);

  const handleLogout = useCallback(async () => {
    setAvatarOpen(false);
    await logout();
    router.push("/login");
  }, [logout, router]);

  const userRoles = useMemo(() => collectUserRoles(user, branchId), [user, branchId]);
  const canUsePos =
    permissionKeys.includes("sales.pos_use") &&
    accessResolved &&
    !!rollout &&
    (backOfficeAccess || rollout.state !== "live");
  const quickSaleHidden =
    pathname === "/pos" ||
    pathname.startsWith("/pos/") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/users") ||
    pathname.startsWith("/audit") ||
    pathname.startsWith("/get-started") ||
    pathname.startsWith("/notifications");

  const showQuickSale = canUsePos && !posHidden && !quickSaleHidden && !chromeHidden;
  // Whole pages opt out above by route; this gets the button out of the way of a single
  // action row, which is what a route list can never keep up with.
  const fabObstructed = useFabClearance(showQuickSale);

  const navGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            (item.href !== "/get-started" || showSetupJourney) &&
            (item.href !== "/pos" || !posHidden) &&
            (!webScopeRestricted ||
              item.href === "/settings" ||
              (item.href === "/pos" && rollout?.state === "fallback")),
        ),
      })).filter((group) => group.items.length > 0),
    [showSetupJourney, posHidden, webScopeRestricted, rollout?.state],
  );

  // Watch the page for its own <h1>. Pages that draw one (a PageHeader, a product hero) keep it;
  // the rest get the shell's. Layout effect, so the fallback never flashes on a page that has one.
  useIsomorphicLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const check = () =>
      setPageHasHeading(main.querySelector("h1:not([data-shell-title])") !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ready, isAuthenticated, pathname, chromeHidden]);

  if (!ready || !isAuthenticated) {
    return (
      <div className={styles.loadingShell}>
        <div className={styles.loadingSpinner} />
      </div>
    );
  }

  const currentBranch = branches.find((b) => b.id === branchId);
  const branchName = currentBranch?.name ?? "Select branch";
  const crumbs = [...buildBreadcrumbs(pathname, lastSegmentLabel), ...extraCrumbs];
  // The page header shows the page's name; the breadcrumb only names the pages above it.
  const pageTitle = crumbs[crumbs.length - 1]?.label ?? "Page";
  const parentCrumbs = crumbs.slice(0, -1);
  const initials = user ? getInitials(user.fullName) : "??";
  const isSettings = pathname === "/settings" || pathname.startsWith("/settings/");

  const sidebarCls = [
    styles.sidebar,
    collapsed ? styles.sidebarCollapsed : "",
    mobileOpen ? styles.sidebarOpen : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={styles.shell}>
      <AppearanceEffect />
      {/* Mobile backdrop */}
      {mobileOpen && !chromeHidden && (
        <div className={styles.backdrop} onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      {!chromeHidden && (
        <aside className={sidebarCls}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarLogo}>
              <svg width="20" height="20" viewBox="0 0 48 48" fill="none" aria-hidden>
                <rect x="8" y="12" width="28" height="22" rx="3" stroke="white" strokeWidth="3" />
                <path
                  d="M16 12V9a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <path d="M24 22v8M20 26h8" stroke="white" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
            {!collapsed && <span className={styles.sidebarBrand}>PharmaCeylon</span>}
          </div>

          <nav className={styles.sidebarNav} aria-label="Main">
            {navGroups.map((group) => {
              // A heading earns its place only over two or more items (#205); over a lone item
              // it just repeats it ("Sales" over "Sales").
              const showHeading = group.items.length > 1;
              return (
                <div
                  key={group.label}
                  className={`${styles.navGroup}${showHeading ? "" : ` ${styles.navGroupHeadless}`}`}
                  role="group"
                  aria-label={showHeading ? group.label : undefined}
                >
                  {showHeading && (
                    <span className={styles.navGroupLabel} aria-hidden>
                      {group.label}
                    </span>
                  )}
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
                        aria-current={active ? "page" : undefined}
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
              );
            })}
          </nav>

          <div className={styles.sidebarFooter}>Version 1.0.0</div>
        </aside>
      )}

      {/* Main */}
      <div
        className={`${styles.main}${collapsed ? ` ${styles.mainCollapsed}` : ""}${chromeHidden ? ` ${styles.mainChromeHidden}` : ""}`}
      >
        {/* Top bar: branch (the page's one scope control), search, theme, notifications,
            account. No page title here (the page header has it) and no New sale (#205). */}
        {!chromeHidden && (
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

            {/* Settings pages state their own scope, so the switch stays off them, as before. */}
            {!isSettings && (
              <div className={styles.branchDropWrap} ref={branchRef}>
                <button
                  type="button"
                  className={styles.branchDropBtn}
                  onClick={() => setBranchOpen((v) => !v)}
                  aria-haspopup="true"
                  aria-expanded={branchOpen}
                  aria-label={`Branch: ${branchName}. Switch branch`}
                >
                  <IconMapPin size={15} />
                  <span className={styles.branchDropName}>{branchName}</span>
                  <IconChevronDown size={14} />
                </button>
                {branchOpen && (
                  <div className={styles.branchDropMenu}>
                    {branches.length === 0 && (
                      <div className={`${styles.branchDropItem} ${styles.branchDropLoading}`}>
                        Loading...
                      </div>
                    )}
                    {branches.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className={`${styles.branchDropItem}${b.id === branchId ? ` ${styles.branchDropItemActive}` : ""}`}
                        aria-current={b.id === branchId ? "true" : undefined}
                        onClick={() => {
                          setBranchId(b.id);
                          setBranchOpen(false);
                        }}
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* GlobalSearch centres itself in its positioned parent; the slot keeps it between
                the branch switch and the icons rather than under them on narrow screens. */}
            <div className={styles.searchSlot}>
              {!webScopeRestricted && (
                <GlobalSearch permissionKeys={permissionKeys} posHidden={posHidden} />
              )}
            </div>

            <div className={styles.topbarRight}>
              <ThemeToggle />
              {!webScopeRestricted && <NotificationCenter />}

              {/* Account */}
              <div className={styles.avatarWrap} ref={avatarRef}>
                <button
                  type="button"
                  className={styles.avatarBtn}
                  onClick={() => setAvatarOpen((v) => !v)}
                  aria-label="User menu"
                  aria-haspopup="true"
                  aria-expanded={avatarOpen}
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
                        onClick={() => {
                          setAvatarOpen(false);
                          router.push("/settings/my-profile");
                        }}
                      >
                        <IconUser size={16} /> Profile
                      </button>
                      <button
                        type="button"
                        className={styles.avatarMenuItem}
                        onClick={() => {
                          setAvatarOpen(false);
                          toggleFullscreen();
                        }}
                      >
                        {isFullscreen ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
                        {isFullscreen ? "Exit full screen" : "Full screen"}
                        <kbd className={styles.avatarMenuKbd}>Ctrl+Shift+F</kbd>
                      </button>
                      <div className={styles.avatarMenuDivider} />
                      <button
                        type="button"
                        className={styles.avatarMenuItem}
                        onClick={handleLogout}
                      >
                        <IconLogOut size={16} /> Logout
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>
        )}

        {/* Every page of the branch while a fallback runs, the full-screen till included. */}
        {rollout?.state === "fallback" && rollout.fallback && (
          <PosFallbackBanner endsAt={rollout.fallback.endsAt} />
        )}

        {/* Page content. The FAB is fixed over this, so reserve its footprint at the
            bottom — otherwise a fully scrolled page ends underneath it. */}
        <main
          ref={mainRef}
          className={`${styles.content}${showQuickSale ? ` ${styles.contentWithFab}` : ""}`}
        >
          {!chromeHidden && parentCrumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
              <ol>
                {parentCrumbs.map((crumb, i) => (
                  <li key={i} className={styles.breadcrumbSegment}>
                    {crumb.href && !webScopeRestricted ? (
                      <Link href={crumb.href} className={styles.breadcrumbLink}>
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className={styles.breadcrumbPage}>{crumb.label}</span>
                    )}
                    <IconChevronRight size={12} aria-hidden />
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {!chromeHidden && pageAllowed && !pageHasHeading && (
            <h1 className={styles.shellTitle} data-shell-title>
              {pageTitle}
            </h1>
          )}
          <PageTitleProvider value={pageTitle}>
            {pageAllowed ? (
              children
            ) : permissionsLoading || (!scopeRollout && !rolloutFailed) ? (
              <p role="status">Checking web access…</p>
            ) : !accessResolved || rolloutFailed ? (
              <p role="alert">Web access could not be checked. Refresh this page to try again.</p>
            ) : (
              <section aria-label="Counter access">
                <h1>Use PharmaCeylon POS</h1>
                <p>
                  Work at your branch counter in PharmaCeylon POS. You can manage your personal
                  account here.
                </p>
                <Link href="/settings/my-profile">My Profile</Link>
                {" · "}
                <Link href="/settings/password-login">Password &amp; Security</Link>
                {" · "}
                <Link href="/settings/appearance">Display settings</Link>
                {rollout?.state === "fallback" && permissionKeys.includes("sales.pos_use") && (
                  <p>
                    <Link href="/pos">Open web POS fallback</Link>
                  </p>
                )}
              </section>
            )}
          </PageTitleProvider>
        </main>
      </div>

      {/* Permission-aware, context-sensitive Quick Sale launcher. Unchanged by #205: hiding web
          selling is W2's job (#64), branch by branch.

          Stays mounted while obstructed rather than unmounting: the overlap is detected from
          this element's own rect, so removing it would clear the overlap and bring it
          straight back. Hidden means invisible, inert and out of the tab order. */}
      {showQuickSale && (
        <Link
          href="/pos"
          data-fab
          className={`${styles.fab}${fabObstructed ? ` ${styles.fabTucked}` : ""}`}
          aria-label="Start a new sale (Ctrl+Shift+P)"
          aria-hidden={fabObstructed || undefined}
          tabIndex={fabObstructed ? -1 : undefined}
        >
          <IconShoppingCart size={24} />
          <span>New Sale</span>
        </Link>
      )}
    </div>
  );
}
