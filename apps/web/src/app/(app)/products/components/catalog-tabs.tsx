"use client";

import Link from "next/link";
import {
  IconArchive,
  IconClipboardList,
  IconGrid,
  IconPackage,
  IconRefresh,
  IconTag,
} from "@/components/icons";
import css from "../products.module.css";

export type CatalogTab =
  | "mine"
  | "reference"
  | "categories"
  | "tags"
  | "organize"
  | "nmra-matches";

type Props = {
  active: CatalogTab;
  /**
   * On the Products page itself the first two tabs switch scope in place rather than
   * navigating, so the list doesn't refetch through a route change. Omitted elsewhere, where
   * they are ordinary links back to Products.
   */
  onScopeChange?: (scope: "mine" | "reference") => void;
  rangedCount?: number | null;
  referenceCount?: number | null;
};

/**
 * The catalog's six views in one row: the two product scopes, the category and tag screens
 * that used to live three clicks deep in Settings, the organize worklist, and the register
 * match worklist.
 *
 * They belong together because they are all the same subject — what this pharmacy sells and
 * how it is organised — and putting the management screens here gets them out of the Settings
 * shell, which cost a data-heavy screen a third of its width to a second navigation rail.
 */
export function CatalogTabs({
  active,
  onScopeChange,
  rangedCount,
  referenceCount,
}: Props) {
  return (
    <div className={css.scopeTabs} role="tablist" aria-label="Product catalog view">
      <ScopeTab
        tab="mine"
        active={active}
        icon={<IconPackage size={15} />}
        label="My products"
        count={rangedCount}
        href="/products"
        onScopeChange={onScopeChange}
      />
      <ScopeTab
        tab="reference"
        active={active}
        icon={<IconArchive size={15} />}
        label="Reference catalog"
        count={referenceCount}
        href="/products?scope=reference"
        tooltip="Medicines imported from the NMRA register that you don't stock yet"
        onScopeChange={onScopeChange}
      />
      <Link
        role="tab"
        aria-selected={active === "categories"}
        href="/products/categories"
        className={`${css.scopeTab}${active === "categories" ? ` ${css.scopeTabActive}` : ""}`}
      >
        <IconGrid size={15} />
        Categories
      </Link>
      <Link
        role="tab"
        aria-selected={active === "tags"}
        href="/products/tags"
        className={`${css.scopeTab}${active === "tags" ? ` ${css.scopeTabActive}` : ""}`}
      >
        <IconTag size={15} />
        Tags
      </Link>
      <Link
        role="tab"
        aria-selected={active === "organize"}
        href="/products/organize"
        className={`${css.scopeTab}${active === "organize" ? ` ${css.scopeTabActive}` : ""}`}
        data-tooltip="Products you sell that aren't filed under a category yet"
      >
        <IconClipboardList size={15} />
        Organize
      </Link>
      <Link
        role="tab"
        aria-selected={active === "nmra-matches"}
        href="/products/nmra-matches"
        className={`${css.scopeTab}${active === "nmra-matches" ? ` ${css.scopeTabActive}` : ""}`}
        data-tooltip="Products that could pick up a registration number from the NMRA register"
      >
        <IconRefresh size={15} />
        Register matches
      </Link>
    </div>
  );
}

function ScopeTab({
  tab,
  active,
  icon,
  label,
  count,
  href,
  tooltip,
  onScopeChange,
}: {
  tab: "mine" | "reference";
  active: CatalogTab;
  icon: React.ReactNode;
  label: string;
  count?: number | null;
  href: string;
  tooltip?: string;
  onScopeChange?: (scope: "mine" | "reference") => void;
}) {
  const className = `${css.scopeTab}${active === tab ? ` ${css.scopeTabActive}` : ""}`;
  const body = (
    <>
      {icon}
      {label}
      {count != null && (
        <span className={css.scopeTabCount}>{count.toLocaleString()}</span>
      )}
    </>
  );

  if (!onScopeChange) {
    return (
      <Link
        role="tab"
        aria-selected={active === tab}
        href={href}
        className={className}
        data-tooltip={tooltip}
      >
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === tab}
      className={className}
      onClick={() => onScopeChange(tab)}
      data-tooltip={tooltip}
    >
      {body}
    </button>
  );
}
