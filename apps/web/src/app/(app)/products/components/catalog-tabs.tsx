"use client";

import Link from "next/link";
import { IconArchive, IconPackage } from "@/components/icons";
import css from "../products.module.css";

export type CatalogTab = "mine" | "reference";

type Props = {
  active: CatalogTab;
  /**
   * On the Products page the two tabs switch scope in place rather than navigating, so the
   * list doesn't refetch through a route change. Omitted elsewhere, where they are ordinary
   * links back to Products.
   */
  onScopeChange?: (scope: CatalogTab) => void;
  rangedCount?: number | null;
  referenceCount?: number | null;
  /** Hide a scope the caller has no permission for — see the Products layout guard. */
  canViewMine?: boolean;
  canViewReference?: boolean;
};

/**
 * Products has exactly two views: what the pharmacy sells, and the register it can add from.
 *
 * It used to have six — Categories, Tags, Organize and Register matches sat alongside these
 * two as equals, which put catalog administration (done occasionally, by a manager) in the
 * same row as the product list (opened constantly, by everyone). Those four moved to
 * Catalog Management, reached from the button beside the page heading; what is left here is
 * the daily work.
 *
 * The counts live on the tabs rather than in a row of KPI cards above them, so a number is
 * stated once. The old page showed the total three times — a stat card, a tab badge and a
 * filter chip — which is a lot of furniture for one integer.
 */
export function CatalogTabs({
  active,
  onScopeChange,
  rangedCount,
  referenceCount,
  canViewMine = true,
  canViewReference = true,
}: Props) {
  return (
    <div
      className={css.scopeTabs}
      role="tablist"
      aria-label="Product catalog view"
    >
      {canViewMine && (
        <ScopeTab
          tab="mine"
          active={active}
          icon={<IconPackage size={15} />}
          label="My products"
          countLabel="products in your range"
          count={rangedCount}
          href="/products"
          onScopeChange={onScopeChange}
        />
      )}
      {canViewReference && (
        <ScopeTab
          tab="reference"
          active={active}
          icon={<IconArchive size={15} />}
          label="Reference catalog"
          countLabel="medicines on the NMRA register"
          count={referenceCount}
          href="/products?scope=reference"
          tooltip="Every medicine on the NMRA register — search it and add what you sell"
          onScopeChange={onScopeChange}
        />
      )}
    </div>
  );
}

function ScopeTab({
  tab,
  active,
  icon,
  label,
  count,
  countLabel,
  href,
  tooltip,
  onScopeChange,
}: {
  tab: CatalogTab;
  active: CatalogTab;
  icon: React.ReactNode;
  label: string;
  count?: number | null;
  countLabel: string;
  href: string;
  tooltip?: string;
  onScopeChange?: (scope: CatalogTab) => void;
}) {
  const selected = active === tab;
  const className = `${css.scopeTab}${selected ? ` ${css.scopeTabActive}` : ""}`;
  // The count is decorative in the visual label and spelled out in the accessible name, so a
  // screen reader hears "Reference catalog, 6,589 medicines on the NMRA register" rather than
  // two unattached numbers.
  const accessibleName =
    count != null ? `${label}, ${count.toLocaleString()} ${countLabel}` : label;
  const body = (
    <>
      {icon}
      {label}
      {count != null && (
        <span className={css.scopeTabCount} aria-hidden>
          {count.toLocaleString()}
        </span>
      )}
    </>
  );

  if (!onScopeChange) {
    return (
      <Link
        role="tab"
        aria-selected={selected}
        aria-label={accessibleName}
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
      aria-selected={selected}
      aria-label={accessibleName}
      className={className}
      onClick={() => onScopeChange(tab)}
      data-tooltip={tooltip}
    >
      {body}
    </button>
  );
}
