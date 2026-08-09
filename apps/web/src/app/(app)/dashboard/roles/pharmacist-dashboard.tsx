"use client";

import { useMemo, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconAlertTriangle,
  IconArchive,
  IconCalendar,
  IconPackage,
  IconPill,
  IconRotateCcw,
  IconSearch,
  IconStethoscope,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatExpiry, formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, POS_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleBarChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { PHARMACIST_AI_INSIGHTS } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

type Props = { data: DashboardData };

const AVATAR_TONE_CLASS = [
  css.avatarTone_0,
  css.avatarTone_1,
  css.avatarTone_2,
  css.avatarTone_3,
  css.avatarTone_4,
  css.avatarTone_5,
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function avatarToneClass(name: string): string {
  const n = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return AVATAR_TONE_CLASS[n % AVATAR_TONE_CLASS.length]!;
}

function expiryTone(iso: string): "danger" | "warning" | "info" {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "danger";
  if (days <= 30) return "warning";
  return "info";
}

function expiryLabel(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "Expired";
  if (days <= 30) return "Within 30 days";
  if (days <= 90) return "Within 90 days";
  return formatExpiry(iso);
}

/** Makes a <tr> behave like a link — click or keyboard-activate to navigate. */
function rowLinkProps(router: ReturnType<typeof useRouter>, href: string) {
  return {
    className: css.rowLink,
    role: "link" as const,
    tabIndex: 0,
    onClick: () => router.push(href),
    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        router.push(href);
      }
    },
  };
}

export function PharmacistDashboard({ data }: Props) {
  const router = useRouter();
  const {
    loading,
    pharmacistHolds,
    nearExpiryCount,
    nearExpiryItems,
    dispensedToday,
    dispensedTrendLabel,
    dispensedTrendPositive,
    hourlyUnitsToday,
    topProductsToday,
    lowStockRows,
    controlledAttentionCount,
    controlledLowStockCount,
    controlledNearExpiryCount,
    returnsTodayCount,
  } = data;

  const peakHour = hourlyUnitsToday.reduce(
    (best, p) => (p.value > best.value ? p : best),
    hourlyUnitsToday[0] ?? { label: "—", value: 0 },
  );

  const oldestHoldWait = useMemo(() => {
    if (pharmacistHolds.length === 0) return null;
    const oldest = pharmacistHolds.reduce((a, b) =>
      new Date(a.createdAt) < new Date(b.createdAt) ? a : b,
    );
    return formatRelativeTime(oldest.createdAt);
  }, [pharmacistHolds]);

  const controlledStockAlerts = controlledLowStockCount + controlledNearExpiryCount;
  const controlledSubtitle =
    controlledLowStockCount > 0 || controlledNearExpiryCount > 0
      ? [
          controlledLowStockCount > 0 ? `${controlledLowStockCount} low stock` : null,
          controlledNearExpiryCount > 0 ? `${controlledNearExpiryCount} near expiry` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Controlled low stock / near expiry";

  const tickerItems: TickerItem[] = useMemo(() => {
    const items: TickerItem[] = [];
    if (nearExpiryCount > 0) {
      items.push({
        key: "exp",
        count: nearExpiryCount,
        label: "batches expiring ≤30 days",
        tone: "warning",
        href: "/inventory/batches",
      });
    }
    if (lowStockRows.length > 0) {
      items.push({
        key: "low",
        count: lowStockRows.length,
        label: "low stock essentials",
        tone: "warning",
        href: "/inventory?view=low",
      });
    }
    if (returnsTodayCount > 0) {
      items.push({
        key: "ret",
        count: returnsTodayCount,
        label: "returns today",
        tone: "info",
        href: "/returns",
      });
    }
    return items;
  }, [nearExpiryCount, lowStockRows.length, returnsTodayCount]);

  return (
    <>
      <HeroBand
        label="Prescriptions to Verify"
        value={pharmacistHolds.length}
        scope="POS holds needing verification"
        meta={
          loading
            ? undefined
            : pharmacistHolds.length > 0
              ? `Oldest waiting ${oldestHoldWait}`
              : "Nothing waiting right now"
        }
        loading={loading}
        secondary={[
          {
            key: "dispensed",
            label: "Dispensed Today",
            value: dispensedToday,
            meta: "Units sold today",
            trend: dispensedTrendLabel
              ? { label: dispensedTrendLabel, direction: dispensedTrendPositive ? "up" : "down" }
              : undefined,
          },
          {
            key: "controlled",
            label: "Controlled Products Attention",
            value: controlledAttentionCount,
            meta: controlledSubtitle,
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No stock or expiry alerts right now" />

      <div className={css.mainSplit}>
        <DashboardPanel
          title="Prescription Verification Queue"
          footerHref="/pos"
          footerLabel="Open POS holds →"
          footerMeta={`${pharmacistHolds.length} waiting`}
        >
          {pharmacistHolds.length === 0 ? (
            <p className={css.emptyState}>No POS holds currently flagged for pharmacist review.</p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>Hold / label</th>
                  <th>Ref</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Held by</th>
                  <th>Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pharmacistHolds.map((h) => {
                  const name = h.label || h.heldByName;
                  return (
                    <tr key={h.id} {...rowLinkProps(router, "/pos?panel=holds")}>
                      <td>
                        <span className={css.avatarRow}>
                          <span className={`${css.avatarChip} ${avatarToneClass(name)}`}>
                            {initials(name)}
                          </span>
                          {name}
                        </span>
                      </td>
                      <td>
                        <span className={css.invoiceLink}>{h.holdRef}</span>
                      </td>
                      <td>{h.itemCount}</td>
                      <td className={css.teamNum}>{formatMoney(h.total)}</td>
                      <td className={css.muted}>{h.heldByName}</td>
                      <td className={css.muted}>{formatRelativeTime(h.createdAt)}</td>
                      <td>
                        <StatusBadge status="pending" label="Awaiting pharmacist" variant="info" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DashboardPanel>

        <DashboardPanel
          title="Drug Interaction / CDS"
          headerRight={<span className={css.placeholderBadge}>Sample</span>}
          footerLabel="Clinical screening coming soon"
          footerMeta="Not connected"
        >
          <ul className={css.aiList}>
            <li className={`${css.aiItem} ${css.aiTone_danger}`}>
              <div>
                <strong>Amoxicillin + Warfarin</strong>
                <p>Bleeding risk increased — sample interaction.</p>
              </div>
              <StatusBadge status="pending" label="High" variant="danger" />
            </li>
            <li className={`${css.aiItem} ${css.aiTone_warning}`}>
              <div>
                <strong>Allergy flag</strong>
                <p>Patient allergy matching not wired.</p>
              </div>
              <StatusBadge status="pending" label="Medium" variant="warning" />
            </li>
            <li className={`${css.aiItem} ${css.aiTone_info}`}>
              <div>
                <strong>Duplicate therapy</strong>
                <p>Screening pipeline not connected yet.</p>
              </div>
              <StatusBadge status="pending" label="Low" variant="success" />
            </li>
          </ul>
        </DashboardPanel>
      </div>

      <div className={css.grid2}>
        <DashboardPanel
          title="Dispensing Workload (Today)"
          footerHref="/pos"
          footerLabel="Open POS →"
          footerMeta={peakHour.value > 0 ? `Peak hour: ${peakHour.label}` : undefined}
        >
          <SimpleBarChart points={hourlyUnitsToday} height={80} />
        </DashboardPanel>

        <DashboardPanel title="Frequently Dispensed" footerHref="/pos" footerLabel="Open POS →">
          {topProductsToday.length === 0 ? (
            <p className={css.emptyState}>No units sold today yet.</p>
          ) : (
            <div className={css.productStrip}>
              {topProductsToday.slice(0, 5).map((p, i) => (
                <div key={p.sku} className={css.productChip}>
                  <span className={css.productAvatar} aria-hidden>
                    {i % 2 === 0 ? (
                      <IconPill size={16} strokeWidth={1.75} />
                    ) : (
                      <IconPackage size={16} strokeWidth={1.75} />
                    )}
                  </span>
                  <div className={css.productChipBody}>
                    <strong>{p.name}</strong>
                    <span>{p.sku}</span>
                    <em>{p.qty} units</em>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DashboardPanel>
      </div>

      <div className={css.grid2}>
        <DashboardPanel
          title="Batch & Expiry Monitor"
          footerHref="/inventory/batches"
          footerLabel="View all batches →"
          footerMeta={`${nearExpiryCount} near expiry`}
        >
          {nearExpiryItems.length === 0 ? (
            <p className={css.emptyState}>No batches expiring within 30 days.</p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th>Status</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {nearExpiryItems.slice(0, 5).map((b) => (
                  <tr
                    key={b.batchId}
                    {...rowLinkProps(router, `/catalog?productId=${b.productId}`)}
                  >
                    <td>
                      {b.product.name}
                      {b.product.isControlled ? <span className={css.muted}> · CD</span> : null}
                    </td>
                    <td>{b.batchNo}</td>
                    <td className={css.muted}>{formatExpiry(b.expiryDate)}</td>
                    <td>
                      <StatusBadge
                        status="pending"
                        label={expiryLabel(b.expiryDate)}
                        variant={expiryTone(b.expiryDate)}
                      />
                    </td>
                    <td>{b.qtyOnHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DashboardPanel>

        <DashboardPanel title="Stock Watch — Therapeutic Essentials" footerHref="/inventory?view=low" footerLabel="Open inventory →">
          {lowStockRows.length === 0 ? (
            <p className={css.emptyState}>No low / out-of-stock essentials right now.</p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Available</th>
                  <th>Min</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {lowStockRows.map((r) => (
                  <tr key={r.productId} {...rowLinkProps(router, `/catalog?productId=${r.productId}`)}>
                    <td>
                      {r.product.name}
                      {r.product.isControlled ? <span className={css.muted}> · CD</span> : null}
                    </td>
                    <td>{r.qtyOnHand}</td>
                    <td>{r.product.reorderLevel}</td>
                    <td>
                      <StatusBadge
                        status={r.qtyOnHand <= 0 ? "failed" : "pending"}
                        label={r.qtyOnHand <= 0 ? "Out of Stock" : "Low Stock"}
                        variant={r.qtyOnHand <= 0 ? "danger" : "warning"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DashboardPanel>
      </div>

      <div className={css.grid2}>
        <DashboardPanel
          title="Controlled Drug Activity (Today)"
          subtitle="Today's real-time counts — tap a tile to act"
        >
          <div className={css.pharmStatStrip}>
            <Link href="/pos?panel=holds" className={`${css.pharmStatCell} ${css.pharmStatCell_primary}`}>
              <span className={css.pharmStatIcon} aria-hidden>
                <IconStethoscope size={16} strokeWidth={1.75} />
              </span>
              <div className={css.pharmStatCopy}>
                <strong className={css.pharmStatValue}>{loading ? "…" : pharmacistHolds.length}</strong>
                <span className={css.pharmStatLabel}>Holds waiting</span>
              </div>
            </Link>
            <Link href="/pos" className={`${css.pharmStatCell} ${css.pharmStatCell_success}`}>
              <span className={css.pharmStatIcon} aria-hidden>
                <IconPill size={16} strokeWidth={1.75} />
              </span>
              <div className={css.pharmStatCopy}>
                <strong className={css.pharmStatValue}>{loading ? "…" : dispensedToday}</strong>
                <span className={css.pharmStatLabel}>Units dispensed</span>
              </div>
            </Link>
            <Link href="/inventory?view=low" className={`${css.pharmStatCell} ${css.pharmStatCell_warning}`}>
              <span className={css.pharmStatIcon} aria-hidden>
                <IconAlertTriangle size={16} strokeWidth={1.75} />
              </span>
              <div className={css.pharmStatCopy}>
                <strong className={css.pharmStatValue}>
                  {loading ? "…" : controlledAttentionCount}
                </strong>
                <span className={css.pharmStatLabel}>CD flagged</span>
              </div>
            </Link>
            <Link
              href="/inventory/batches?nearExpiryDays=30"
              className={`${css.pharmStatCell} ${css.pharmStatCell_danger}`}
            >
              <span className={css.pharmStatIcon} aria-hidden>
                <IconArchive size={16} strokeWidth={1.75} />
              </span>
              <div className={css.pharmStatCopy}>
                <strong className={css.pharmStatValue}>{loading ? "…" : controlledStockAlerts}</strong>
                <span className={css.pharmStatLabel}>CD stock alerts</span>
              </div>
            </Link>
          </div>
        </DashboardPanel>

        <AiInsightsCard title="AI Clinical Insights" insights={PHARMACIST_AI_INSIGHTS} />
      </div>

      <QuickActionsBar
        title="Pharmacist Quick Actions"
        actions={[
          {
            href: "/pos?panel=holds",
            label: "Pharmacist holds",
            icon: <IconStethoscope size={18} />,
            roles: POS_ROLES,
            tone: "primary",
          },
          {
            href: "/pos?mode=prescription",
            label: "Rx sale mode",
            icon: <IconPill size={18} />,
            roles: POS_ROLES,
            tone: "info",
          },
          {
            href: "/catalog",
            label: "Drug profile lookup",
            icon: <IconSearch size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "success",
          },
          {
            href: "/inventory/batches?nearExpiryDays=30",
            label: "Near expiry",
            icon: <IconCalendar size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
          {
            href: "/inventory?view=low",
            label: "Stock watch",
            icon: <IconAlertTriangle size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "warning",
          },
          {
            href: "/inventory/movements",
            label: "Stock movements",
            icon: <IconPackage size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "success",
          },
          {
            href: "/pos?mode=returns",
            label: "Counter return",
            icon: <IconRotateCcw size={18} />,
            roles: POS_ROLES,
            tone: "danger",
          },
        ]}
      />
    </>
  );
}
