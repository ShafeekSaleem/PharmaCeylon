"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconAlertTriangle,
  IconBox,
  IconChevronRight,
  IconClipboardList,
  IconFileText,
  IconGrid,
  IconPackage,
  IconShoppingCart,
  IconTruck,
} from "@/components/icons";
import detailCss from "../product-detail.module.css";
import type { AuditHistoryItem, Product, ProductDetail, ProductDetailTab } from "../types";
import {
  formatAuditEventName,
  formatDate,
  formatDateTime,
  formatHistorySummary,
  formatRelativeTime,
  historyEventCategory,
} from "../utils/format";
import type { ProductNavLink } from "../utils/product-routes";
import { ProductStockBadge } from "./product-stock-badge";

const WORKFLOW_ICONS: Record<string, ReactNode> = {
  inventory: <IconPackage size={16} />,
  movements: <IconActivity size={16} />,
  batches: <IconBox size={16} />,
  adjustments: <IconClipboardList size={16} />,
  purchasing: <IconClipboardList size={16} />,
  transfers: <IconTruck size={16} />,
  pos: <IconShoppingCart size={16} />,
  catalog: <IconGrid size={16} />,
  audit: <IconFileText size={16} />,
};

type Props = {
  activeTab: ProductDetailTab;
  navLinks: ProductNavLink[];
  detail: ProductDetail;
  product: Product;
  productId: string;
};

function pricingHistoryItems(history: AuditHistoryItem[]) {
  return history.filter(
    (item) => historyEventCategory(item.eventName, item.payload) === "pricing",
  );
}

export function ProductDetailSidebar({
  activeTab,
  navLinks,
  detail,
  product,
  productId,
}: Props) {
  const summary = detail.branchSummary;
  const hasBranch = detail.qtyOnHand !== null;
  const latest = detail.history[0] ?? null;
  const recentPriceChanges = pricingHistoryItems(detail.history).slice(0, 3);

  return (
    <aside className={detailCss.sidebarColumn}>
      <div className={detailCss.sideCard}>
        <h3 className={detailCss.sideCardTitle}>Related workflows</h3>
        <nav className={detailCss.navGrid} aria-label="Product operations">
          {navLinks.map((link) =>
            link.ready ? (
              <Link key={link.id} href={link.href} className={detailCss.navItem}>
                <div className={detailCss.navItemHead}>
                  <span className={detailCss.navItemLabelRow}>
                    <span className={detailCss.navItemIcon}>{WORKFLOW_ICONS[link.id]}</span>
                    {link.label}
                  </span>
                  <IconChevronRight size={14} className={detailCss.navChevron} />
                </div>
                <p className={detailCss.navItemDesc}>{link.description}</p>
              </Link>
            ) : (
              <div key={link.id} className={`${detailCss.navItem} ${detailCss.navItemDisabled}`}>
                <div className={detailCss.navItemHead}>
                  <span className={detailCss.navItemLabelRow}>
                    <span className={detailCss.navItemIcon}>{WORKFLOW_ICONS[link.id]}</span>
                    {link.label}
                  </span>
                  <span className={detailCss.navSoonBadge}>Soon</span>
                </div>
                <p className={detailCss.navItemDesc}>{link.description}</p>
              </div>
            ),
          )}
        </nav>
      </div>

      {activeTab === "pricing" && (
        <>
          <div className={detailCss.sideCard}>
            <h3 className={detailCss.sideCardTitle}>Price rules &amp; notes</h3>
            <dl className={detailCss.branchSummaryList}>
              <div className={detailCss.branchSummaryRow}>
                <dt>Controlled substance</dt>
                <dd>
                  {product.isControlled ? (
                    <span
                      className={`${detailCss.controlledFieldBadge} ${detailCss.controlledFieldBadgeYes}`}
                    >
                      Yes
                    </span>
                  ) : (
                    "No"
                  )}
                </dd>
              </div>
              <div className={detailCss.branchSummaryRow}>
                <dt>Notes</dt>
                <dd className={detailCss.sideNoteText}>
                  Prices follow batch cost at receipt. Margin is calculated from primary FEFO batch.
                </dd>
              </div>
            </dl>
          </div>

          <div className={detailCss.sideCard}>
            <div className={detailCss.sideCardHead}>
              <h3 className={detailCss.sideCardTitle}>Recent price changes</h3>
              <Link
                href={`/products/${productId}?tab=history`}
                className={detailCss.sideCardLink}
              >
                View all
              </Link>
            </div>
            {recentPriceChanges.length === 0 ? (
              <p className={detailCss.sideEmptyText}>No price changes recorded yet.</p>
            ) : (
              <ul className={detailCss.sideChangeList}>
                {recentPriceChanges.map((item) => (
                  <li key={item.id} className={detailCss.sideChangeItem}>
                    <div className={detailCss.sideChangeHead}>
                      <span className={detailCss.sideChangeEvent}>
                        {formatAuditEventName(item.eventName)}
                      </span>
                      <span className={detailCss.sideChangeTime}>
                        {formatDateTime(item.createdAt)}
                      </span>
                    </div>
                    <p className={detailCss.sideChangeSummary}>
                      {formatHistorySummary(item.eventName, item.payload)}
                    </p>
                    <span className={detailCss.sideChangeActor}>
                      {item.actor?.fullName ?? "System"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {activeTab === "history" && (
        <div className={detailCss.sideCard}>
          <h3 className={detailCss.sideCardTitle}>History summary</h3>
          <dl className={detailCss.branchSummaryList}>
            <div className={detailCss.branchSummaryRow}>
              <dt>Total entries</dt>
              <dd>{detail.history.length}</dd>
            </div>
            <div className={detailCss.branchSummaryRow}>
              <dt>Last updated by</dt>
              <dd>{latest?.actor?.fullName ?? "—"}</dd>
            </div>
            <div className={detailCss.branchSummaryRow}>
              <dt>Latest activity</dt>
              <dd>
                {latest
                  ? `${formatAuditEventName(latest.eventName)} · ${formatDateTime(latest.createdAt)}`
                  : "—"}
              </dd>
            </div>
          </dl>
          <Link
            href={`/audit?entityName=product&entityId=${productId}`}
            className={detailCss.footerLink}
          >
            View full audit log
            <IconChevronRight size={14} />
          </Link>
        </div>
      )}

      {hasBranch && summary && (activeTab === "history" || activeTab === "overview" || activeTab === "stock") && (
        <div className={detailCss.sideCard}>
          <h3 className={detailCss.sideCardTitle}>
            At this branch ({summary.branchName})
          </h3>
          <dl className={detailCss.branchSummaryList}>
            <div className={detailCss.branchSummaryRow}>
              <dt>Current stock</dt>
              <dd>
                <ProductStockBadge
                  qtyOnHand={detail.qtyOnHand}
                  stockStatus={detail.stockStatus}
                  reorderGap={detail.reorderGap}
                  reorderLevel={product.reorderLevel}
                  variant="inline"
                />
              </dd>
            </div>
            <div className={detailCss.branchSummaryRow}>
              <dt>Last movement</dt>
              <dd>{formatRelativeTime(summary.lastMovementAt)}</dd>
            </div>
            {summary.nextExpiryBatchNo && (
              <div className={detailCss.branchSummaryRow}>
                <dt>Next expiry</dt>
                <dd>
                  <span className={detailCss.nextExpiryBadge}>
                    <IconAlertTriangle size={11} />
                    <span>
                      <strong>{summary.nextExpiryBatchNo}</strong>
                      {summary.nextExpiryDays != null && summary.nextExpiryDays >= 0 && (
                        <> · {summary.nextExpiryDays}d left ({formatDate(summary.nextExpiryDate)})</>
                      )}
                    </span>
                  </span>
                </dd>
              </div>
            )}
            <div className={detailCss.branchSummaryRow}>
              <dt>Avg. monthly usage</dt>
              <dd>
                {summary.avgMonthlyUsage != null
                  ? `${summary.avgMonthlyUsage} units/mo`
                  : "—"}
              </dd>
            </div>
          </dl>
          <Link href={`/inventory/movements?productId=${productId}`} className={detailCss.footerLink}>
            View inventory details
            <IconChevronRight size={14} />
          </Link>
        </div>
      )}
    </aside>
  );
}
