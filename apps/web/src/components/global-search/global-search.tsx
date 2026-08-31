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
import css from "./global-search.module.css";

type SearchResultType =
  | "product"
  | "sale"
  | "customer"
  | "supplier"
  | "purchase_order"
  | "transfer"
  | "stocktake"
  | "action";

type SearchResult = {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
  badge?: string;
  imageUrl?: string;
};

type SearchGroup = { key: string; label: string; items: SearchResult[] };
type SearchResponse = { query: string; groups: SearchGroup[]; total: number };
/** `permission` is recorded at selection time (see `permissionFor`) so a stale entry from a
 *  role/permission that's since changed — a different login, a branch switch, an edited custom
 *  role — gets filtered back out at render time instead of showing forever. */
type RecentItem = Pick<
  SearchResult,
  "id" | "type" | "title" | "subtitle" | "href"
> & { permission?: string };

const RECENT_KEY = "pc_global_search_recent";

/** The permission each remote search-result type requires — mirrors exactly what
 *  `search.service.ts`'s `globalSearch` checks per category before it will even run that
 *  query, so "Recent" never keeps showing something this role can no longer search for.
 *  Quick actions carry their own per-item `permission` instead (see QUICK_ACTIONS below). */
const TYPE_PERMISSION: Partial<Record<SearchResultType, string>> = {
  product: "products.view",
  sale: "sales.view",
  customer: "customers.view",
  supplier: "suppliers.view",
  purchase_order: "purchasing.view",
  transfer: "transfers.view",
  stocktake: "stocktakes.use",
};

function permissionFor(item: SearchResult): string | undefined {
  return (item as { permission?: string }).permission ?? TYPE_PERMISSION[item.type];
}

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

/** Every result type gets its own hue so a mixed-group dropdown scans at a glance
 *  instead of every row reading as the same flat brand-teal icon chip. */
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
      return <IconTruck {...props} />;
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

const ICON_TONE: Record<SearchResultType, string> = {
  product: "icon_product",
  sale: "icon_sale",
  customer: "icon_customer",
  supplier: "icon_supplier",
  purchase_order: "icon_purchaseOrder",
  transfer: "icon_transfer",
  stocktake: "icon_stocktake",
  action: "icon_action",
};

export function GlobalSearch({ permissionKeys }: { permissionKeys: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remoteGroups, setRemoteGroups] = useState<SearchGroup[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

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
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
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
    const visibleRecent = recent.filter((item) => allowed(item.permission));
    if (!needle && visibleRecent.length) {
      groups.push({ key: "recent", label: "Recent", items: visibleRecent });
    }
    if (actions.length)
      groups.push({ key: "actions", label: "Quick actions", items: actions });
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
      const recentEntry: RecentItem = {
        id: item.id,
        type: item.type,
        title: item.title,
        subtitle: item.subtitle,
        href: item.href,
        permission: permissionFor(item),
      };
      const nextRecent: RecentItem[] = [
        recentEntry,
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

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      inputRef.current?.blur();
    } else if (event.key === "ArrowDown") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex((index) => Math.min(flatItems.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && open && flatItems[activeIndex]) {
      event.preventDefault();
      selectItem(flatItems[activeIndex]);
    }
  }

  let runningIndex = -1;
  return (
    <div className={css.root} data-open={open} ref={rootRef}>
      <div
        className={`${css.trigger}${open ? ` ${css.triggerOpen}` : ""}`}
        onMouseDown={(event) => {
          if (event.target !== inputRef.current) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        <IconSearch size={16} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          value={query}
          placeholder="Search products, sales, suppliers…"
          aria-label="Search products, sales, suppliers and more"
          aria-expanded={open}
          aria-controls="global-search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={
            open && flatItems[activeIndex]
              ? `global-search-${activeIndex}`
              : undefined
          }
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
        />
        {loading ? (
          <span className={css.spinner} aria-label="Searching" />
        ) : (
          <kbd>Ctrl K</kbd>
        )}
      </div>

      {open ? (
        <div className={css.panel}>
          <div id="global-search-listbox" className={css.results} role="listbox">
            {groups.map((group) => (
              <div key={group.key} className={css.group}>
                <div className={css.groupLabel}>{group.label}</div>
                {group.items.map((item) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const showThumb = item.type === "product" && item.imageUrl;
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
                      {showThumb ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          className={css.resultThumb}
                        />
                      ) : (
                        <span
                          className={`${css.resultIcon} ${css[ICON_TONE[item.type]]}`}
                        >
                          {iconFor(item.type)}
                        </span>
                      )}
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
                <IconSearch size={22} />
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
            <span>
              <kbd>Esc</kbd> Close
            </span>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
