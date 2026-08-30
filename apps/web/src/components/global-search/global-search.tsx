"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  IconBarChart,
  IconBox,
  IconClipboardList,
  IconFileText,
  IconPackage,
  IconSearch,
  IconShoppingCart,
  IconTruck,
  IconUsers,
} from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import css from "./global-search.module.css";

type SearchResultType =
  | "product"
  | "sale"
  | "customer"
  | "supplier"
  | "purchase_order"
  | "transfer"
  | "stocktake"
  | "page"
  | "action";

type SearchResult = {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
  badge?: string;
};

type SearchGroup = { key: string; label: string; items: SearchResult[] };
type SearchResponse = { query: string; groups: SearchGroup[]; total: number };
type RecentItem = Pick<
  SearchResult,
  "id" | "type" | "title" | "subtitle" | "href"
>;

const RECENT_KEY = "pc_global_search_recent";

const DESTINATIONS: Array<SearchResult & { permission?: string }> = [
  {
    id: "dashboard",
    type: "page",
    title: "Dashboard",
    subtitle: "Business overview and priorities",
    href: "/dashboard",
  },
  {
    id: "products",
    type: "page",
    title: "Products",
    subtitle: "Product catalog and details",
    href: "/products",
    permission: "products.view",
  },
  {
    id: "inventory",
    type: "page",
    title: "Inventory",
    subtitle: "Stock levels, batches and movements",
    href: "/inventory",
    permission: "inventory.view",
  },
  {
    id: "purchasing",
    type: "page",
    title: "Purchasing",
    subtitle: "Purchase orders and receiving",
    href: "/purchasing",
    permission: "purchasing.view",
  },
  {
    id: "suppliers",
    type: "page",
    title: "Suppliers",
    subtitle: "Supplier directory and accounts",
    href: "/suppliers",
    permission: "suppliers.view",
  },
  {
    id: "transfers",
    type: "page",
    title: "Transfers",
    subtitle: "Branch stock transfers",
    href: "/transfers",
    permission: "transfers.view",
  },
  {
    id: "stocktakes",
    type: "page",
    title: "Stocktakes",
    subtitle: "Counts, reviews and postings",
    href: "/stocktakes",
    permission: "stocktakes.use",
  },
  {
    id: "reports",
    type: "page",
    title: "Reports",
    subtitle: "Sales, profitability and operations",
    href: "/reports",
    permission: "reports.view",
  },
  {
    id: "users",
    type: "page",
    title: "Users & Roles",
    subtitle: "Staff access and permissions",
    href: "/users",
    permission: "users.view",
  },
  {
    id: "settings",
    type: "page",
    title: "Settings",
    subtitle: "Profile and application preferences",
    href: "/settings",
  },
];

const QUICK_ACTIONS: Array<SearchResult & { permission: string }> = [
  {
    id: "new-sale",
    type: "action",
    title: "Start a new sale",
    subtitle: "Open POS / Checkout",
    href: "/pos",
    permission: "sales.pos_use",
  },
  {
    id: "new-po",
    type: "action",
    title: "Create purchase order",
    subtitle: "Start a new supplier order",
    href: "/purchasing?action=create-po",
    permission: "purchasing.manage",
  },
  {
    id: "new-transfer",
    type: "action",
    title: "Create stock transfer",
    subtitle: "Move stock between branches",
    href: "/transfers?action=create",
    permission: "transfers.manage",
  },
  {
    id: "low-stock",
    type: "action",
    title: "Review low stock",
    subtitle: "Open products requiring replenishment",
    href: "/inventory?view=low",
    permission: "inventory.view",
  },
];

function readRecent(): RecentItem[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(RECENT_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(value) ? (value as RecentItem[]).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function iconFor(type: SearchResultType) {
  const props = { size: 17 };
  switch (type) {
    case "product":
      return <IconPackage {...props} />;
    case "sale":
      return <IconFileText {...props} />;
    case "customer":
      return <IconUsers {...props} />;
    case "supplier":
      return <IconUsers {...props} />;
    case "purchase_order":
      return <IconClipboardList {...props} />;
    case "transfer":
      return <IconTruck {...props} />;
    case "stocktake":
      return <IconBox {...props} />;
    case "action":
      return <IconShoppingCart {...props} />;
    default:
      return <IconBarChart {...props} />;
  }
}

export function GlobalSearch({ permissionKeys }: { permissionKeys: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const triggerRef = useRef<HTMLInputElement>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remoteGroups, setRemoteGroups] = useState<SearchGroup[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  useBodyScrollLock(open);

  const allowed = useCallback(
    (permission?: string) => !permission || permissionKeys.includes(permission),
    [permissionKeys],
  );

  useEffect(() => setRecent(readRecent()), []);
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") {
        event.preventDefault();
        if (document.querySelector('[role="dialog"][aria-modal="true"]'))
          return;
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => dialogInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemoteGroups([]);
      setLoading(false);
      setError(false);
      return;
    }
    const currentRequest = ++requestId.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(false);
      apiJson<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limit=5`)
        .then((response) => {
          if (requestId.current === currentRequest)
            setRemoteGroups(response.groups);
        })
        .catch(() => {
          if (requestId.current === currentRequest) {
            setRemoteGroups([]);
            setError(true);
          }
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const localGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (item: SearchResult) =>
      !needle ||
      `${item.title} ${item.subtitle}`.toLowerCase().includes(needle);
    const groups: SearchGroup[] = [];
    const actions = QUICK_ACTIONS.filter(
      (item) => allowed(item.permission) && matches(item),
    );
    const pages = DESTINATIONS.filter(
      (item) => allowed(item.permission) && matches(item),
    );
    if (!needle && recent.length) {
      groups.push({ key: "recent", label: "Recent", items: recent });
    }
    if (actions.length)
      groups.push({ key: "actions", label: "Quick actions", items: actions });
    if (pages.length)
      groups.push({
        key: "pages",
        label: "Pages",
        items: pages.slice(0, needle ? 8 : 5),
      });
    return groups;
  }, [allowed, query, recent]);

  const groups = useMemo(
    () => [...remoteGroups, ...localGroups],
    [remoteGroups, localGroups],
  );
  const flatItems = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  );

  useEffect(() => setActiveIndex(0), [query, groups.length]);

  const selectItem = useCallback(
    (item: SearchResult) => {
      const nextRecent: RecentItem[] = [
        item,
        ...recent.filter((row) => row.href !== item.href),
      ].slice(0, 6);
      setRecent(nextRecent);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(nextRecent));
      } catch {}
      setOpen(false);
      setQuery("");
      router.push(item.href);
    },
    [recent, router],
  );

  function onDialogKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(flatItems.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && flatItems[activeIndex]) {
      event.preventDefault();
      selectItem(flatItems[activeIndex]);
    }
  }

  let runningIndex = -1;
  return (
    <>
      <div className={css.trigger}>
        <IconSearch size={16} />
        <input
          ref={triggerRef}
          type="search"
          value=""
          placeholder="Search products, sales, suppliers…"
          aria-label="Open global search"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
        />
        <kbd>Ctrl K</kbd>
      </div>

      {open ? (
        <div
          className={css.backdrop}
          role="presentation"
          onMouseDown={() => setOpen(false)}
        >
          <section
            className={css.palette}
            role="dialog"
            aria-modal="true"
            aria-label="Global search"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className={css.inputRow}>
              <IconSearch size={20} />
              <input
                ref={dialogInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onDialogKeyDown}
                placeholder="Search products, invoices, customers, suppliers…"
                aria-controls="global-search-results"
                aria-activedescendant={
                  flatItems[activeIndex]
                    ? `global-search-${activeIndex}`
                    : undefined
                }
              />
              {loading ? (
                <span className={css.spinner} aria-label="Searching" />
              ) : (
                <kbd>Esc</kbd>
              )}
            </div>

            <div
              id="global-search-results"
              className={css.results}
              role="listbox"
            >
              {groups.map((group) => (
                <div key={group.key} className={css.group}>
                  <div className={css.groupLabel}>{group.label}</div>
                  {group.items.map((item) => {
                    runningIndex += 1;
                    const index = runningIndex;
                    return (
                      <button
                        id={`global-search-${index}`}
                        key={`${item.type}:${item.id}`}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        className={`${css.result}${index === activeIndex ? ` ${css.resultActive}` : ""}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => selectItem(item)}
                      >
                        <span className={css.resultIcon}>
                          {iconFor(item.type)}
                        </span>
                        <span className={css.resultCopy}>
                          <span className={css.resultTitle}>{item.title}</span>
                          <span className={css.resultSubtitle}>
                            {item.subtitle}
                          </span>
                        </span>
                        {item.meta ? (
                          <span className={css.resultMeta}>{item.meta}</span>
                        ) : null}
                        {item.badge ? (
                          <span className={css.badge}>
                            {item.badge.replace(/_/g, " ")}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              {!loading && !groups.length ? (
                <div className={css.empty}>
                  <IconSearch size={24} />
                  <strong>No results found</strong>
                  <span>
                    Try a product name, barcode, invoice number or supplier.
                  </span>
                </div>
              ) : null}
              {error ? (
                <div className={css.error}>
                  Search is temporarily unavailable. Page shortcuts still work.
                </div>
              ) : null}
            </div>

            <footer className={css.footer}>
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> Navigate
              </span>
              <span>
                <kbd>Enter</kbd> Open
              </span>
              <span>Results respect your current branch and permissions</span>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
