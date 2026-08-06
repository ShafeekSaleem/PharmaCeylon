"use client";

import Link from "next/link";
import {
  IconAlertTriangle,
  IconCalendar,
  IconClipboardList,
  IconFileText,
  IconPackage,
  IconPill,
  IconRotateCcw,
  IconShoppingCart,
  IconStethoscope,
} from "@/components/icons";
import { StatCard, StatusBadge } from "@/components/ui";
import { formatExpiry, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, POS_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { DashboardPanel } from "../components/dashboard-panel";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleBarChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import {
  PHARMACIST_AI_INSIGHTS,
  PLACEHOLDER_COUNSELING,
  PLACEHOLDER_REFILL_FOLLOWUPS,
} from "../lib/placeholder-data";
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

export function PharmacistDashboard({ data }: Props) {
  const {
    loading,
    pharmacistHolds,
    nearExpiryCount,
    nearExpiryItems,
    dispensedToday,
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

  const controlledSubtitle =
    controlledLowStockCount > 0 || controlledNearExpiryCount > 0
      ? [
          controlledLowStockCount > 0 ? `${controlledLowStockCount} low stock` : null,
          controlledNearExpiryCount > 0 ? `${controlledNearExpiryCount} near expiry` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Controlled low stock / near expiry";

  return (
    <>
      <div className={css.kpiRow}>
        <StatCard
          title="Near Expiry Batches"
          value={loading ? "…" : nearExpiryCount}
          subtitle="Within 30 days"
          icon={<IconCalendar size={16} strokeWidth={1.75} />}
          iconTone="warning"
          trend={
            nearExpiryCount > 0
              ? { value: "Watch", direction: "up", tone: "warning" }
              : undefined
          }
          menuItems={[
            { label: "View batches", href: "/inventory/batches" },
            { label: "Open inventory", href: "/inventory" },
          ]}
        />
        <StatCard
          title="Dispensed Today"
          value={loading ? "…" : dispensedToday}
          subtitle="Units sold today"
          icon={<IconShoppingCart size={16} strokeWidth={1.75} />}
          iconTone="success"
          menuItems={[
            { label: "Open POS", href: "/pos" },
            { label: "View catalog", href: "/catalog" },
          ]}
        />
        <StatCard
          title="Holds awaiting pharmacist"
          value={loading ? "…" : pharmacistHolds.length}
          subtitle="POS holds needing verify"
          icon={<IconFileText size={16} strokeWidth={1.75} />}
          iconTone="primary"
          trend={
            pharmacistHolds.length > 0
              ? { value: "Queue", direction: "up", tone: "warning" }
              : undefined
          }
          menuItems={[
            { label: "Open POS queue", href: "/pos" },
            { label: "View catalog", href: "/catalog" },
          ]}
        />
        <StatCard
          title="Controlled products attention"
          value={loading ? "…" : controlledAttentionCount}
          subtitle={controlledSubtitle}
          icon={<IconStethoscope size={16} strokeWidth={1.75} />}
          iconTone="warning"
          trend={
            controlledAttentionCount > 0
              ? { value: "Review", direction: "up", tone: "warning" }
              : undefined
          }
          menuItems={[
            { label: "Open inventory", href: "/inventory" },
            { label: "Near-expiry batches", href: "/inventory/batches" },
          ]}
        />
        <StatCard
          title="Low Stock Essentials"
          value={loading ? "…" : lowStockRows.length}
          subtitle="Low / out of stock"
          icon={<IconPackage size={16} strokeWidth={1.75} />}
          iconTone="danger"
          trend={
            lowStockRows.length > 0
              ? { value: "Action", direction: "up", tone: "danger" }
              : undefined
          }
          menuItems={[
            { label: "View low stock", href: "/inventory?view=low" },
            { label: "Open inventory", href: "/inventory" },
          ]}
        />
        <StatCard
          title="Returns Today"
          value={loading ? "…" : returnsTodayCount}
          subtitle="Refunded / partial returns"
          icon={<IconRotateCcw size={16} strokeWidth={1.75} />}
          iconTone="info"
          menuItems={[
            { label: "Open returns", href: "/returns" },
            { label: "Open POS", href: "/pos" },
          ]}
        />
      </div>

      <div className={css.grid3}>
        <DashboardPanel
          title="Holds awaiting pharmacist"
          className={css.span2}
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
                  <th>Held by</th>
                  <th>Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pharmacistHolds.map((h) => {
                  const name = h.label || h.heldByName;
                  return (
                    <tr key={h.id}>
                      <td>
                        <span className={css.avatarRow}>
                          <span
                            className={`${css.avatarChip} ${avatarToneClass(name)}`}
                          >
                            {initials(name)}
                          </span>
                          {name}
                        </span>
                      </td>
                      <td>
                        <Link href="/pos" className={css.invoiceLink}>
                          {h.holdRef}
                        </Link>
                      </td>
                      <td>{h.itemCount}</td>
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
          <p className={css.placeholderNote}>
            No clinical decision support — sample alerts for layout only.
          </p>
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

      <div className={css.grid3}>
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
                {nearExpiryItems.map((b) => (
                  <tr key={b.batchId}>
                    <td>
                      {b.product.name}
                      {b.product.isControlled ? (
                        <span className={css.muted}> · CD</span>
                      ) : null}
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

        <DashboardPanel
          title="Dispense volume (today)"
          footerHref="/pos"
          footerLabel="Open POS →"
          footerMeta={peakHour.value > 0 ? `Peak hour: ${peakHour.label}` : undefined}
        >
          <SimpleBarChart points={hourlyUnitsToday} height={140} />
          <p className={css.placeholderNote}>
            Units sold by hour today — sales volume proxy, not clinical workload.
          </p>
        </DashboardPanel>

        <DashboardPanel
          title="Frequently Dispensed"
          footerHref="/pos"
          footerLabel="Open POS →"
        >
          {topProductsToday.length === 0 ? (
            <p className={css.emptyState}>No units sold today yet.</p>
          ) : (
            <div className={css.productStrip}>
              {topProductsToday.slice(0, 6).map((p) => (
                <div key={p.sku} className={css.productChip}>
                  <span className={css.productAvatar} aria-hidden>
                    {p.name.slice(0, 2).toUpperCase()}
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

      <div className={css.grid4}>
        <DashboardPanel
          title="Refill / Patient Follow-up"
          headerRight={<span className={css.placeholderBadge}>Sample</span>}
          footerMeta="CRM coming soon"
        >
          <p className={css.placeholderNote}>Patient refill reminders are not wired yet.</p>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Medicine</th>
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {PLACEHOLDER_REFILL_FOLLOWUPS.map((row) => (
                <tr key={row.id}>
                  <td>{row.patient}</td>
                  <td className={css.muted}>{row.medicine}</td>
                  <td>{row.due}</td>
                  <td>
                    <StatusBadge
                      status="pending"
                      label={row.status}
                      variant={row.status === "Due" ? "danger" : "info"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DashboardPanel>

        <DashboardPanel
          title="Controlled drug register"
          headerRight={<span className={css.placeholderBadge}>Sample</span>}
          footerMeta="Register coming soon"
        >
          <div className={css.complianceBlocks}>
            <div className={`${css.complianceBlock} ${css.compliance_issued}`}>
              <strong>{pharmacistHolds.length}</strong>
              Holds waiting
            </div>
            <div className={`${css.complianceBlock} ${css.compliance_dispensed}`}>
              <strong>{dispensedToday}</strong>
              Units today
            </div>
            <div className={`${css.complianceBlock} ${css.compliance_checked}`}>
              <strong>{controlledAttentionCount}</strong>
              CD attention
            </div>
            <div className={`${css.complianceBlock} ${css.compliance_discrepancy}`}>
              <strong className={css.placeholderValue}>
                —
              </strong>
              Gaps (sample)
            </div>
          </div>
          <p className={css.placeholderNote}>
            Register discrepancy checks are placeholders — not a live CD register.
          </p>
        </DashboardPanel>

        <AiInsightsCard
          title="AI Clinical Insights"
          insights={PHARMACIST_AI_INSIGHTS}
          footerMeta="Clinical AI coming soon"
        />

        <DashboardPanel
          title="Stock Watch — Essentials"
          footerHref="/inventory?view=low"
          footerLabel="Open inventory →"
        >
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
                  <tr key={r.productId}>
                    <td>
                      {r.product.name}
                      {r.product.isControlled ? (
                        <span className={css.muted}> · CD</span>
                      ) : null}
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

      <div className={css.grid3}>
        <DashboardPanel
          title="Pending Counseling"
          headerRight={<span className={css.placeholderBadge}>Sample</span>}
          footerMeta="Counseling log coming soon"
        >
          <p className={css.placeholderNote}>
            Counseling queue is not tracked yet — sample rows for layout only.
          </p>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Topic</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              {PLACEHOLDER_COUNSELING.map((row) => (
                <tr key={row.id}>
                  <td>{row.patient}</td>
                  <td className={css.muted}>{row.topic}</td>
                  <td>
                    <StatusBadge
                      status="pending"
                      label={row.priority}
                      variant={row.priority === "High" ? "danger" : "warning"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DashboardPanel>
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
