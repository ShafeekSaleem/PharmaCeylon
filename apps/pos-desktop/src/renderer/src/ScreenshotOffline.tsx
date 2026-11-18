/**
 * The nominated counter selling offline, for screenshot captures (P4 #50, 4b). Not shipped in
 * the Electron app — built only into screenshot.html. `?page=offline` renders the real
 * OfflineCounter over a `window.pos` that answers like main does; the capture script clicks
 * through it. `&hours=needs` starts outside selling hours, `&till=other` with someone else's
 * shift open and a manager signed in.
 */
import { useState } from "react";
import type {
  LocalShift,
  OfflineModeState,
  OfflineReceiptView,
  OfflineStaff,
  ShiftState,
} from "../../shared/ipc-contract";
import type { OfflineStockLine } from "./offline-sell-model";

export function offlineShot(search: string) {
  const params = new URLSearchParams(search);
  if (params.get("page") !== "offline") return null;
  return {
    hours: params.get("hours") === "needs",
    otherTill: params.get("till") === "other",
  };
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (h: number, m: number, dayOffset = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
};

const sachini = id(1);
const dilini = id(2);

export const offlineMode = (): OfflineModeState => ({
  mode: "offline",
  reason: null,
  clock: null,
  connected: false,
  outageStartedAt: at(15, 48).toISOString(),
  grantExpiresAt: at(8, 12, 1).toISOString(),
  snapshotGeneratedAt: at(15, 41).toISOString(),
});

const line = (
  n: number,
  name: string,
  priceMinor: number,
  remaining: number,
  batchNo: string,
  blocked: OfflineStockLine["blocked"] = null,
  barcode: string | null = null,
): OfflineStockLine => ({
  snapshotLineId: `line-${n}`,
  productId: id(100 + n),
  batchId: id(200 + n),
  remaining,
  unitPriceMinor: priceMinor,
  sellBefore: at(0, 0, 400 + n * 30).getTime(),
  blocked,
  display: { name, strength: null, barcode, batchNo },
});

const stock: OfflineStockLine[] = [
  line(1, "Panadol 500mg Tablets", 9600, 18, "PN2409", null, "4791111"),
  line(2, "Panadol Extra Tablets", 14200, 6, "PX2410", "STOCK_REVIEW"),
  line(3, "Jeevanee ORS Sachet", 4500, 40, "JV2511"),
  line(4, "Link Samahan Herbal Drink", 2800, 64, "LS2601"),
  line(
    5,
    "Amoxicillin 500mg Capsules",
    3200,
    120,
    "AX2502",
    "NOT_SOLD_OFFLINE",
  ),
  line(6, "Vitamin C 500mg Chewable", 18500, 9, "VC2507"),
];

const people = (canAck: boolean): OfflineStaff["people"] => [
  {
    staffUserId: sachini,
    staffName: "Sachini Rathnayake",
    canAssistClose: false,
    canAcknowledgeHours: false,
    lockRemainingMs: 0,
  },
  {
    staffUserId: dilini,
    staffName: "Dilini Fernando",
    canAssistClose: true,
    canAcknowledgeHours: canAck,
    lockRemainingMs: 0,
  },
  {
    staffUserId: id(3),
    staffName: "Kasun Jayasinghe",
    canAssistClose: false,
    canAcknowledgeHours: false,
    lockRemainingMs: 9 * 60_000,
  },
];

export function offlineShift(otherTill: boolean): LocalShift {
  return {
    workSessionId: id(10),
    shiftNumber: "S-0412",
    staffUserId: sachini,
    staffName: "Sachini Rathnayake",
    openedAt: at(8, 2).toISOString(),
    openingCashMinor: 500_000,
    openingCount: [{ denominationMinor: 100_000, count: 5 }],
    status: "open",
    sync: "synced",
    error: null,
    expectedCashMinor: otherTill ? 1_262_400 : 2_485_000,
    closedAt: null,
    closedByName: null,
    closingCashCountMinor: null,
    serverExpectedCashMinor: null,
    varianceMinor: null,
    varianceNote: null,
    assistanceReason: null,
    needsManagerPin: false,
    summary: null,
    summaryAt: null,
  };
}

/** A `window.pos` that answers what the offline counter asks for, the way main would. */
export function installOfflineFixture(shot: {
  hours: boolean;
  otherTill: boolean;
}) {
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
  const me = shot.otherTill
    ? { staffUserId: dilini, staffName: "Dilini Fernando" }
    : { staffUserId: sachini, staffName: "Sachini Rathnayake" };
  let staff: OfflineStaff = {
    signedIn: {
      ...me,
      signedInAt: at(15, 50).toISOString(),
      workSessionId: shot.otherTill ? id(11) : id(10),
    },
    people: people(true),
    hours: shot.hours
      ? { status: "needs_acknowledgement" }
      : { status: "open" },
  };
  let card: { amountMinor: number; reference: string; code: string } | null =
    null;
  const byId = new Map(stock.map((l) => [l.snapshotLineId, l]));
  const price = (items: { snapshotLineId: string; quantity: number }[]) => {
    const lines = items.map((i) => {
      const l = byId.get(i.snapshotLineId)!;
      return {
        snapshotLineId: l.snapshotLineId,
        productId: l.productId,
        batchId: l.batchId,
        quantity: i.quantity,
        unitPriceMinor: l.unitPriceMinor,
        taxMinor: 0,
        lineTotalMinor: l.unitPriceMinor * i.quantity,
        display: l.display,
      };
    });
    const total = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
    return { lines, total };
  };
  const pos = {
    offlineStaff: () => Promise.resolve(staff),
    offlineStock: () => ok(stock),
    offlineQuote: ({
      items,
    }: {
      items: { snapshotLineId: string; quantity: number }[];
    }) => {
      const { lines, total } = price(items);
      return ok({
        lines,
        blocked: [],
        subtotalMinor: total,
        taxMinor: 0,
        totalMinor: total,
        digest: "shot",
      });
    },
    offlinePrepareCard: ({ amountMinor }: { amountMinor: number }) => {
      card = { amountMinor, reference: "", code: "" };
      return ok({ attemptId: id(900), digest: "shot" });
    },
    offlineCardOutcome: ({
      outcome,
    }: {
      outcome: { kind: string; reference?: string; approvalCode?: string };
    }) => {
      if (card && outcome.kind === "approved")
        card = {
          ...card,
          reference: outcome.reference ?? "",
          code: outcome.approvalCode ?? "",
        };
      const state =
        outcome.kind === "not_sure"
          ? "uncertain"
          : outcome.kind === "never_charged"
            ? "declined"
            : outcome.kind;
      return ok({ state });
    },
    offlineCommitSale: ({
      items,
      cashTenderedMinor,
    }: {
      items: { snapshotLineId: string; quantity: number }[];
      cashTenderedMinor?: number;
    }) => {
      const { lines, total } = price(items);
      const onCard = card?.amountMinor ?? 0;
      const cashDue = total - onCard;
      const tendered = cashTenderedMinor ?? 0;
      const payments: OfflineReceiptView["payments"] = [];
      if (card)
        payments.push({
          method: "external_card",
          amountMinor: onCard,
          providerReference: card.reference,
          approvalCode: card.code,
          approvedAt: Date.now(),
        });
      if (cashDue > 0)
        payments.push({
          method: "cash",
          amountMinor: cashDue,
          tenderedMinor: tendered,
          changeMinor: tendered - cashDue,
        });
      card = null;
      return ok<OfflineReceiptView>({
        receiptNumber: "C1R-000186",
        saleCommandId: id(800),
        checkoutDraftId: id(801),
        soldAt: Date.now(),
        sellerName: me.staffName,
        lines,
        subtotalMinor: total,
        taxMinor: 0,
        totalMinor: total,
        payments,
        changeMinor: cashDue > 0 ? tendered - cashDue : 0,
      });
    },
    offlineAcknowledgeHours: ({ minutes }: { minutes: number }) => {
      staff = {
        ...staff,
        hours: {
          status: "acknowledged",
          until: new Date(Date.now() + minutes * 60_000).toISOString(),
          managerName: "Dilini Fernando",
        },
      };
      return ok(staff);
    },
    offlineCloseShift: () => ok(staff),
    offlineSignIn: () => ok(staff),
    printOfflineReceipt: () => Promise.resolve({ ok: true, error: null }),
  };
  Object.defineProperty(window, "pos", {
    value: new Proxy(pos as Record<string, unknown>, {
      get: (target, name) =>
        typeof name === "string" && name in target
          ? target[name]
          : name === "then"
            ? undefined
            : () => new Promise(() => undefined),
    }),
    configurable: true,
    writable: true,
  });
}

/** The till's shift as the offline counter reads it. */
export function useOfflineShiftState(otherTill: boolean) {
  const [state] = useState<ShiftState>(() => ({
    current: offlineShift(otherTill),
    lastClosed: null,
    unsynced: [],
  }));
  return state;
}
