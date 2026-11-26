"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconBanknote, IconClipboardList, IconUsers } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";
import { BarRows, type BarRow } from "../components/bar-rows";
import { ReportSelect } from "../components/report-select";
import { fetchShiftCashReport } from "../lib/fetchers";
import { formatMoney } from "../lib/format";
import type { ExportPayload, OnExportData, Scope, ShiftCashReportResponse, ShiftCashRow, ShiftCashTotals } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const ALL = "all";

/** Minor units (cents) to the app's money format. */
export const money = (minor: number | null | undefined) => (minor == null ? "—" : formatMoney(minor / 100));

/** Signed, so a shortage reads "−LKR 100.00" and an overage "+LKR 50.00". */
export function signedMoney(minor: number | null | undefined): string {
  if (minor == null) return "—";
  if (minor === 0) return money(0);
  return `${minor > 0 ? "+" : "−"}${money(Math.abs(minor))}`;
}

function when(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(DISPLAY_LOCALE, {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function varianceBar(key: string, label: string, sublabel: string, t: ShiftCashTotals): BarRow {
  return {
    key,
    label,
    sublabel,
    value: t.shortMinor + t.overMinor,
    valueLabel: signedMoney(t.netVarianceMinor),
    subValue: t.shortMinor > 0 ? `${money(t.shortMinor)} short` : t.overMinor > 0 ? `${money(t.overMinor)} over` : "Balanced",
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * W10 #72: does each drawer reconcile? Every till shift opened in the range with its opening
 * float, the cash that came in and went out, what should have been in the drawer, what was
 * counted and the difference — by staff member (whose drawer it was) and by counter. Assisted
 * closes name the manager who counted, and shifts replayed from an offline counter are labelled.
 */
export function ShiftCashSection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<ShiftCashReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerId, setRegisterId] = useState(ALL);
  const [staffUserId, setStaffUserId] = useState(ALL);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchShiftCashReport(days, scope, isOwner, {
      registerId: registerId === ALL ? undefined : registerId,
      staffUserId: staffUserId === ALL ? undefined : staffUserId,
    })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load shift cash data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner, registerId, staffUserId]);

  const timeZone = data?.timeZone ?? "Asia/Colombo";
  // Name the branch beside each counter whenever more than one branch is in view.
  const multiBranch = useMemo(
    () => scope === "tenant" || new Set((data?.options.registers ?? []).map((r) => r.branchName)).size > 1,
    [data, scope],
  );

  const staffRows: BarRow[] = useMemo(
    () =>
      (data?.byStaff ?? []).map((s) =>
        varianceBar(
          s.staffUserId,
          s.name,
          [plural(s.closedShifts, "closed shift"), s.assistedCloses ? `${s.assistedCloses} assisted` : null, s.openShifts ? `${s.openShifts} open` : null]
            .filter(Boolean)
            .join(" · "),
          s,
        ),
      ),
    [data],
  );

  const counterRows: BarRow[] = useMemo(
    () =>
      (data?.byCounter ?? []).map((c) =>
        varianceBar(
          c.registerId,
          multiBranch ? `${c.label} · ${c.branchName}` : c.label,
          [plural(c.closedShifts, "closed shift"), c.shiftsWithVariance ? `${c.shiftsWithVariance} with a difference` : null]
            .filter(Boolean)
            .join(" · "),
          c,
        ),
      ),
    [data, multiBranch],
  );

  const registerOptions = useMemo(
    () => [
      { value: ALL, label: "All counters" },
      ...(data?.options.registers ?? []).map((r) => ({ value: r.id, label: multiBranch ? `${r.label} · ${r.branchName}` : r.label })),
    ],
    [data, multiBranch],
  );
  const staffOptions = useMemo(
    () => [{ value: ALL, label: "All staff" }, ...(data?.options.staff ?? []).map((s) => ({ value: s.id, label: s.name }))],
    [data],
  );

  const selected = useMemo(() => {
    const rows = data?.shifts ?? [];
    return rows.find((r) => r.shiftId === selectedId) ?? rows[0] ?? null;
  }, [data, selectedId]);

  const columns: Column<ShiftCashRow>[] = [
    {
      key: "shift",
      header: "Shift",
      width: "7.5rem",
      sortable: true,
      getValue: (r) => r.openedAt,
      render: (r) => (
        <>
          <span className={css.skucode}>{r.shiftNumber}</span>
          <div className={css.mutedcell}>{when(r.openedAt, timeZone)}</div>
        </>
      ),
    },
    {
      key: "counter",
      header: "Counter",
      width: "7rem",
      render: (r) => (
        <>
          {r.counterLabel}
          <div className={css.mutedcell}>{multiBranch ? r.branchName : r.terminalLabel ?? ""}</div>
        </>
      ),
    },
    { key: "staff", header: "Staff", width: "7rem", sortable: true, getValue: (r) => r.staff.name, render: (r) => r.staff.name },
    { key: "expected", header: "Expected", align: "right", width: "6.5rem", sortable: true, getValue: (r) => r.expectedCashMinor, render: (r) => money(r.expectedCashMinor) },
    { key: "counted", header: "Counted", align: "right", width: "6.5rem", sortable: true, getValue: (r) => r.countedCashMinor, render: (r) => money(r.countedCashMinor) },
    {
      key: "variance",
      header: "Difference",
      align: "right",
      width: "6.5rem",
      sortable: true,
      getValue: (r) => r.varianceMinor,
      render: (r) =>
        r.varianceMinor == null ? (
          <span className={css.mutedcell}>—</span>
        ) : (
          <span className={r.varianceMinor < 0 ? css.deltaDown : r.varianceMinor > 0 ? css.deltaUp : undefined}>{signedMoney(r.varianceMinor)}</span>
        ),
    },
    {
      key: "close",
      header: "Close",
      width: "8rem",
      render: (r) => (
        <>
          {r.status === "open" ? (
            <span className={`${css.badge2} ${css.badge2Tight} ${css.monitor}`}>Open</span>
          ) : r.closeKind === "assisted" ? (
            <span className={`${css.badge2} ${css.badge2Tight} ${css.watch}`} data-tooltip={r.assistanceReason ?? undefined}>
              Assisted
            </span>
          ) : (
            <span className={`${css.badge2} ${css.badge2Tight} ${css.healthy}`}>Self</span>
          )}{" "}
          {r.openedOffline || r.closedOffline ? (
            <span className={`${css.badge2} ${css.badge2Tight} ${css.return}`} data-tooltip="Recorded on a counter while it was offline, then synced">
              Offline
            </span>
          ) : null}
          {r.closedBy && r.closeKind === "assisted" ? <div className={css.mutedcell}>by {r.closedBy.name}</div> : null}
        </>
      ),
    },
  ];

  useEffect(() => {
    if (!data || data.shifts.length === 0) {
      onExportData(null);
      return;
    }
    const major = (minor: number | null) => (minor == null ? "" : (minor / 100).toFixed(2));
    const payload: ExportPayload = {
      filename: `shift-cash-${days}d.csv`,
      headers: [
        "Shift",
        "Branch",
        "Counter",
        "Computer",
        "Staff",
        "Status",
        "Opened",
        "Closed",
        "Opening float",
        "Cash taken",
        "Change given",
        "Cash refunds",
        "Paid out",
        "Paid in",
        "Expected cash",
        "Counted cash",
        "Difference",
        "Counter's expected",
        "Sales",
        "Sales total",
        "Close",
        "Closed by",
        "Assistance reason",
        "Note",
        "Offline",
      ],
      rows: data.shifts.map((r) => [
        r.shiftNumber,
        r.branchName,
        r.counterLabel,
        r.terminalLabel ?? "",
        r.staff.name,
        r.status,
        r.openedAt,
        r.closedAt ?? "",
        major(r.openingCashMinor),
        major(r.cashTakenMinor),
        major(r.changeGivenMinor),
        major(r.cashRefundsMinor),
        major(r.cashPaidOutMinor),
        major(r.cashPaidInMinor),
        major(r.expectedCashMinor),
        major(r.countedCashMinor),
        major(r.varianceMinor),
        major(r.counterExpectedCashMinor),
        r.saleCount,
        major(r.salesTotalMinor),
        r.closeKind ?? "",
        r.closedBy?.name ?? "",
        r.assistanceReason ?? "",
        r.varianceNote ?? "",
        r.openedOffline || r.closedOffline ? "Yes" : "No",
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [data, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  const kpis = data?.kpis;
  const dash = loading || !kpis;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Cash Counted"
          value={dash ? "…" : money(kpis.countedCashMinor)}
          subtitle={dash ? "Closed shifts" : `Expected ${money(kpis.expectedCashMinor)}`}
          icon={<IconBanknote size={16} />}
          iconTone="primary"
        />
        <StatCard size="sm" showMenu={false}
          title="Net Difference"
          value={dash ? "…" : signedMoney(kpis.netVarianceMinor)}
          subtitle={dash ? "Counted − expected" : `${money(kpis.shortMinor)} short · ${money(kpis.overMinor)} over`}
          icon={<IconAlertTriangle size={16} />}
          iconTone={!dash && kpis.netVarianceMinor < 0 ? "danger" : "warning"}
        />
        <StatCard size="sm" showMenu={false}
          title="Shifts With a Difference"
          value={dash ? "…" : `${kpis.shiftsWithVariance} / ${kpis.closedShifts}`}
          subtitle={dash ? "Closed shifts" : kpis.counterDisagreements ? `${plural(kpis.counterDisagreements, "counter disagreement")}` : "Closed shifts"}
          icon={<IconClipboardList size={16} />}
          iconTone="warning"
        />
        <StatCard size="sm" showMenu={false}
          title="Shifts"
          value={dash ? "…" : String(kpis.shifts)}
          subtitle={
            dash
              ? "Opened in this range"
              : [`${kpis.openShifts} open`, `${kpis.assistedCloses} assisted`, kpis.offlineShifts ? `${kpis.offlineShifts} offline` : null].filter(Boolean).join(" · ")
          }
          icon={<IconUsers size={16} />}
          iconTone="success"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Difference by Staff</h3>
              <p>Whose drawer it was — an assisted close stays with the cashier</p>
            </div>
          </div>
          <BarRows rows={staffRows} danger pageSize={6} onRowClick={(key) => setStaffUserId(key === staffUserId ? ALL : key)} activeKey={staffUserId === ALL ? null : staffUserId} />
        </div>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Difference by Counter</h3>
              <p>Shortages and overages on each till</p>
            </div>
          </div>
          <BarRows rows={counterRows} danger pageSize={6} onRowClick={(key) => setRegisterId(key === registerId ? ALL : key)} activeKey={registerId === ALL ? null : registerId} />
        </div>
      </div>

      <div className={`${css.card} ${css.firstRow}`} id="shift-table">
        <div className={css.cardhead}>
          <div>
            <h3>Shifts</h3>
            <p>Every shift opened in this range, newest first. Pick one to see how its drawer adds up.</p>
          </div>
          <div className={css.cardheadFilters}>
            <ReportSelect ariaLabel="Counter" value={registerId} onChange={setRegisterId} options={registerOptions} />
            <ReportSelect ariaLabel="Staff" value={staffUserId} onChange={setStaffUserId} options={staffOptions} />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={data?.shifts ?? []}
          rowKey={(r) => r.shiftId}
          loading={loading}
          pageSize={10}
          emptyTitle="No shifts opened in this range"
          compact
          onRowClick={(r) => setSelectedId(r.shiftId)}
          rowClassName={(r) => (selected && r.shiftId === selected.shiftId ? css.selectedRow : undefined)}
        />
      </div>

      {selected ? <DrawerBreakdown shift={selected} timeZone={timeZone} /> : null}
    </div>
  );
}

/** How one drawer adds up, line by line, the way the counter's close screen shows it. */
export function DrawerBreakdown({ shift, timeZone }: { shift: ShiftCashRow; timeZone: string }) {
  const lines: Array<{ label: string; minor: number; sign: "+" | "−" }> = [
    { label: "Opening float", minor: shift.openingCashMinor, sign: "+" },
    { label: "Cash taken", minor: shift.cashTakenMinor, sign: "+" },
    { label: "Change given", minor: shift.changeGivenMinor, sign: "−" },
    { label: "Cash refunds", minor: shift.cashRefundsMinor, sign: "−" },
    { label: "Paid out", minor: shift.cashPaidOutMinor, sign: "−" },
    { label: "Paid in", minor: shift.cashPaidInMinor, sign: "+" },
  ];
  return (
    <div className={`${css.card} ${css.firstRow}`} aria-label={`Drawer for shift ${shift.shiftNumber}`}>
      <div className={css.cardhead}>
        <div>
          <h3>Drawer · {shift.shiftNumber}</h3>
          <p>
            {shift.staff.name} on {shift.counterLabel}, {when(shift.openedAt, timeZone)} to {shift.closedAt ? when(shift.closedAt, timeZone) : "now (still open)"}
            {" · "}
            {plural(shift.saleCount, "sale")}, {money(shift.salesTotalMinor)}
          </p>
        </div>
      </div>
      <table className={css.drawerTable}>
        <tbody>
          {lines.map((line) => (
            <tr key={line.label}>
              <td>{line.label}</td>
              <td className={css.drawerAmount}>
                {line.sign} {money(line.minor)}
              </td>
            </tr>
          ))}
          <tr className={css.drawerTotal}>
            <td>{shift.status === "open" ? "Expected now" : "Expected"}</td>
            <td className={css.drawerAmount}>{money(shift.expectedCashMinor)}</td>
          </tr>
          {shift.status === "closed" ? (
            <>
              <tr>
                <td>Counted</td>
                <td className={css.drawerAmount}>{money(shift.countedCashMinor)}</td>
              </tr>
              <tr className={css.drawerTotal}>
                <td>Difference</td>
                <td className={`${css.drawerAmount} ${(shift.varianceMinor ?? 0) < 0 ? css.deltaDown : (shift.varianceMinor ?? 0) > 0 ? css.deltaUp : ""}`}>
                  {signedMoney(shift.varianceMinor)}
                </td>
              </tr>
            </>
          ) : null}
        </tbody>
      </table>
      {shift.counterDifferenceMinor ? (
        <p className={css.drawerNote}>
          The counter expected {money(shift.counterExpectedCashMinor)}, {signedMoney(shift.counterDifferenceMinor)} from the server&apos;s figure.
        </p>
      ) : null}
      {shift.closeKind === "assisted" ? (
        <p className={css.drawerNote}>
          Closed by {shift.closedBy?.name ?? "a manager"} for {shift.staff.name}: {shift.assistanceReason}
        </p>
      ) : null}
      {shift.varianceNote ? <p className={css.drawerNote}>Note: {shift.varianceNote}</p> : null}
      {shift.openedOffline || shift.closedOffline ? (
        <p className={css.drawerNote}>
          {shift.openedOffline && shift.closedOffline ? "Opened and closed" : shift.openedOffline ? "Opened" : "Closed"} on the counter while it was offline, then synced.
        </p>
      ) : null}
    </div>
  );
}
