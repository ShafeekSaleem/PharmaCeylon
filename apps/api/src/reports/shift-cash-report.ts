import { expectedCash, type ExpectedCashParts } from "../terminals/shifts/till-shift-math";

/**
 * W10 #72: the shift and cash reconciliation report. One row per till shift opened in the
 * window, with the drawer's sums laid out the way the counter's close screen adds them up
 * (opening + cash taken − change − cash refunds − paid out + paid in = expected), the count, and
 * the variance. Rolled up by the shift's owner (whose drawer it was) and by counter.
 *
 * Money is in minor units (cents of LKR), as on `till_shift`. A closed shift reports the figures
 * recorded when it closed, never a recomputation; an open shift's expected cash is live.
 */

export type ShiftCashPerson = Readonly<{ id: string; name: string }>;

/** The shift row and what the report needs beside it, as the loader reads them. */
export type ShiftCashInput = Readonly<{
  id: string;
  shiftNumber: string;
  branchId: string;
  branchName: string;
  registerId: string;
  counterLabel: string;
  terminalId: string;
  terminalLabel: string | null;
  staff: ShiftCashPerson;
  openedAt: Date;
  closedAt: Date | null;
  openingCashMinor: number;
  closingCashCountMinor: number | null;
  expectedCashMinor: number | null;
  counterExpectedCashMinor: number | null;
  varianceMinor: number | null;
  closeKind: "self" | "assisted" | null;
  closedBy: ShiftCashPerson | null;
  assistanceReason: string | null;
  varianceNote: string | null;
  /** Opened from a signed offline `shift_open` (P5 replay). */
  openedOffline: boolean;
  /** Closed from an offline sign-in (P5 replay). */
  closedOffline: boolean;
  cashTakenMinor: number;
  changeGivenMinor: number;
  cashRefundsMinor: number;
  cashPaidOutMinor: number;
  cashPaidInMinor: number;
  saleCount: number;
  salesTotalMinor: number;
}>;

export type ShiftCashRow = Readonly<{
  shiftId: string;
  shiftNumber: string;
  branchId: string;
  branchName: string;
  registerId: string;
  counterLabel: string;
  terminalId: string;
  terminalLabel: string | null;
  staff: ShiftCashPerson;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  openingCashMinor: number;
  cashTakenMinor: number;
  changeGivenMinor: number;
  cashRefundsMinor: number;
  cashPaidOutMinor: number;
  cashPaidInMinor: number;
  /** Recorded at close; live (from the shift's own rows) while open. */
  expectedCashMinor: number;
  /** Null while open. */
  countedCashMinor: number | null;
  /** Counted − expected; null while open. Negative is short. */
  varianceMinor: number | null;
  /** The counter's own running expected figure at close, beside the server's. */
  counterExpectedCashMinor: number | null;
  /** Counter's expected − server's expected, when the counter sent one. Non-zero means the
   * counter and server disagreed about what should be in the drawer. */
  counterDifferenceMinor: number | null;
  saleCount: number;
  salesTotalMinor: number;
  closeKind: "self" | "assisted" | null;
  closedBy: ShiftCashPerson | null;
  assistanceReason: string | null;
  varianceNote: string | null;
  openedOffline: boolean;
  closedOffline: boolean;
}>;

type VarianceTotals = {
  shifts: number;
  closedShifts: number;
  openShifts: number;
  /** Closed shifts whose count differed from expected. */
  shiftsWithVariance: number;
  assistedCloses: number;
  /** Sum of shortages, as a positive number. */
  shortMinor: number;
  overMinor: number;
  /** Over − short. */
  netVarianceMinor: number;
};

export type ShiftCashStaffRow = Readonly<VarianceTotals & { staffUserId: string; name: string }>;
export type ShiftCashCounterRow = Readonly<
  VarianceTotals & { registerId: string; label: string; branchId: string; branchName: string }
>;

export type ShiftCashKpis = Readonly<
  VarianceTotals & {
    /** Across closed shifts: what should have been in the drawers, and what was counted. */
    expectedCashMinor: number;
    countedCashMinor: number;
    /** Across every shift, open ones included: cash tendered (before change) and change given. */
    cashTakenMinor: number;
    changeGivenMinor: number;
    cashRefundsMinor: number;
    cashPaidOutMinor: number;
    cashPaidInMinor: number;
    /** Shifts opened or closed from an offline counter and replayed (P5). */
    offlineShifts: number;
    /** Closed shifts where the counter's expected figure differed from the server's. */
    counterDisagreements: number;
  }
>;

export type ShiftCashFilters = Readonly<{ registerId?: string; staffUserId?: string }>;

export type ShiftCashReportResponse = Readonly<{
  days: number;
  timeZone: string;
  /** Window start (inclusive) and end (exclusive), as instants: shifts opened in it are listed. */
  since: string;
  before: string;
  filters: ShiftCashFilters;
  kpis: ShiftCashKpis;
  byStaff: ShiftCashStaffRow[];
  byCounter: ShiftCashCounterRow[];
  /** Newest first. */
  shifts: ShiftCashRow[];
  /** Filter choices from every shift in the window, before `filters` are applied. */
  options: Readonly<{
    registers: Array<Readonly<{ id: string; label: string; branchName: string }>>;
    staff: ShiftCashPerson[];
  }>;
}>;

export function shiftCashRow(input: ShiftCashInput): ShiftCashRow {
  const parts: ExpectedCashParts = {
    openingCashMinor: input.openingCashMinor,
    cashTakenMinor: input.cashTakenMinor,
    changeGivenMinor: input.changeGivenMinor,
    cashRefundsMinor: input.cashRefundsMinor,
    cashPaidOutMinor: input.cashPaidOutMinor,
    cashPaidInMinor: input.cashPaidInMinor,
  };
  const closed = input.closedAt !== null;
  const expected = closed && input.expectedCashMinor !== null ? input.expectedCashMinor : expectedCash(parts);
  return {
    shiftId: input.id,
    shiftNumber: input.shiftNumber,
    branchId: input.branchId,
    branchName: input.branchName,
    registerId: input.registerId,
    counterLabel: input.counterLabel,
    terminalId: input.terminalId,
    terminalLabel: input.terminalLabel,
    staff: input.staff,
    status: closed ? "closed" : "open",
    openedAt: input.openedAt.toISOString(),
    closedAt: input.closedAt?.toISOString() ?? null,
    ...parts,
    expectedCashMinor: expected,
    countedCashMinor: closed ? input.closingCashCountMinor : null,
    varianceMinor: closed ? input.varianceMinor : null,
    counterExpectedCashMinor: input.counterExpectedCashMinor,
    counterDifferenceMinor:
      closed && input.counterExpectedCashMinor !== null ? input.counterExpectedCashMinor - expected : null,
    saleCount: input.saleCount,
    salesTotalMinor: input.salesTotalMinor,
    closeKind: input.closeKind,
    closedBy: input.closedBy,
    assistanceReason: input.assistanceReason,
    varianceNote: input.varianceNote,
    openedOffline: input.openedOffline,
    closedOffline: input.closedOffline,
  };
}

const emptyTotals = (): VarianceTotals => ({
  shifts: 0,
  closedShifts: 0,
  openShifts: 0,
  shiftsWithVariance: 0,
  assistedCloses: 0,
  shortMinor: 0,
  overMinor: 0,
  netVarianceMinor: 0,
});

function addShift(totals: VarianceTotals, row: ShiftCashRow) {
  totals.shifts += 1;
  if (row.status === "open") {
    totals.openShifts += 1;
    return;
  }
  totals.closedShifts += 1;
  if (row.closeKind === "assisted") totals.assistedCloses += 1;
  const variance = row.varianceMinor ?? 0;
  if (variance !== 0) totals.shiftsWithVariance += 1;
  if (variance < 0) totals.shortMinor += -variance;
  if (variance > 0) totals.overMinor += variance;
  totals.netVarianceMinor += variance;
}

/** Worst shortage first, then most shifts, then name, so the people and counters to look at
 * come first. */
function byShortage<T extends VarianceTotals>(a: T & { sortName: string }, b: T & { sortName: string }) {
  return b.shortMinor - a.shortMinor || b.shifts - a.shifts || a.sortName.localeCompare(b.sortName);
}

export function buildShiftCashReport(
  inputs: readonly ShiftCashInput[],
  meta: Readonly<{ days: number; timeZone: string; since: Date; before: Date; filters: ShiftCashFilters }>,
): ShiftCashReportResponse {
  const registers = new Map<string, { id: string; label: string; branchName: string }>();
  const staff = new Map<string, ShiftCashPerson>();
  for (const input of inputs) {
    registers.set(input.registerId, { id: input.registerId, label: input.counterLabel, branchName: input.branchName });
    staff.set(input.staff.id, input.staff);
  }

  const { registerId, staffUserId } = meta.filters;
  const rows = inputs
    .filter((input) => (!registerId || input.registerId === registerId) && (!staffUserId || input.staff.id === staffUserId))
    .map(shiftCashRow)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.shiftNumber.localeCompare(a.shiftNumber));

  const kpis = {
    ...emptyTotals(),
    expectedCashMinor: 0,
    countedCashMinor: 0,
    cashTakenMinor: 0,
    changeGivenMinor: 0,
    cashRefundsMinor: 0,
    cashPaidOutMinor: 0,
    cashPaidInMinor: 0,
    offlineShifts: 0,
    counterDisagreements: 0,
  };
  const staffTotals = new Map<string, VarianceTotals & { staffUserId: string; name: string }>();
  const counterTotals = new Map<
    string,
    VarianceTotals & { registerId: string; label: string; branchId: string; branchName: string }
  >();

  for (const row of rows) {
    addShift(kpis, row);
    // Cash taken is gross (tendered, before change), like each row and the CSV; change is its own
    // total. These drawer movements cover every shift, open ones included.
    kpis.cashTakenMinor += row.cashTakenMinor;
    kpis.changeGivenMinor += row.changeGivenMinor;
    kpis.cashRefundsMinor += row.cashRefundsMinor;
    kpis.cashPaidOutMinor += row.cashPaidOutMinor;
    kpis.cashPaidInMinor += row.cashPaidInMinor;
    if (row.openedOffline || row.closedOffline) kpis.offlineShifts += 1;
    if (row.status === "closed") {
      kpis.expectedCashMinor += row.expectedCashMinor;
      kpis.countedCashMinor += row.countedCashMinor ?? 0;
      if (row.counterDifferenceMinor) kpis.counterDisagreements += 1;
    }

    const person = staffTotals.get(row.staff.id) ?? { ...emptyTotals(), staffUserId: row.staff.id, name: row.staff.name };
    addShift(person, row);
    staffTotals.set(row.staff.id, person);

    const counter = counterTotals.get(row.registerId) ?? {
      ...emptyTotals(),
      registerId: row.registerId,
      label: row.counterLabel,
      branchId: row.branchId,
      branchName: row.branchName,
    };
    addShift(counter, row);
    counterTotals.set(row.registerId, counter);
  }

  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  return {
    days: meta.days,
    timeZone: meta.timeZone,
    since: meta.since.toISOString(),
    before: meta.before.toISOString(),
    filters: meta.filters,
    kpis,
    byStaff: [...staffTotals.values()]
      .map((t) => ({ ...t, sortName: t.name }))
      .sort(byShortage)
      .map(({ sortName: _sortName, ...t }) => t),
    byCounter: [...counterTotals.values()]
      .map((t) => ({ ...t, sortName: `${t.branchName} ${t.label}` }))
      .sort(byShortage)
      .map(({ sortName: _sortName, ...t }) => t),
    shifts: rows,
    options: {
      registers: [...registers.values()].sort(
        (a, b) => a.branchName.localeCompare(b.branchName) || a.label.localeCompare(b.label),
      ),
      staff: [...staff.values()].sort(byName),
    },
  };
}
