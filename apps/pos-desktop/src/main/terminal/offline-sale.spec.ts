import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  offlineSalePolicyError,
  terminalSigningText,
  type BranchStockSnapshot,
  type ExternalCardAttemptRecord,
  type OfflineGrant,
  type OfflineJournalCommand,
  type OfflineSaleCommand,
  type OfflineShiftOpenCommand,
  type OfflineStaffSignIn,
  type Signed,
  type StockSnapshotLine,
} from "@pharmaceylon/shared";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import type { PosDatabase } from "../db/database";
import { DeviceKey } from "../device/device-key";
import { DeviceStore } from "../device/device-store";
import { openLocalStore, type LocalStore } from "../local-store";
import { PinStore } from "../staff/pin-store";
import {
  installOfflineAuthority,
  readInstalledOfflineAuthority,
  type OfflineAuthority,
} from "./offline-authority";
import { OfflineCounterService } from "./offline-counter";
import { OfflineJournalWriter } from "./offline-journal-writer";
import { renderSaleReceiptHtml } from "../printing/receipt-html";
import {
  OfflineSaleService,
  nextOfflineReceiptNumber,
  offlineLineLabel,
  offlineReceiptForPrinting,
} from "./offline-sale";
import { TrustedClock } from "./trusted-clock";
import { drainHolds } from "./reconnect-drain";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};

const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const deviceKey = DeviceKey.generate();
const NOW = Date.UTC(2026, 10, 17, 4, 0);
const ISSUED = NOW - 500;
const UP0 = 3_600_000;
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};
const counter = { registerId: randomUUID(), tillId: randomUUID() };
const cashier = { staffUserId: randomUUID(), name: "Nimal", pin: "1234" };
const manager = { staffUserId: randomUUID(), name: "Dilani", pin: "5678" };

const line = (
  id: string,
  over: Partial<StockSnapshotLine> = {},
): StockSnapshotLine => ({
  snapshotLineId: id,
  productId: `product-${id}`,
  batchId: id,
  availableQuantity: 5,
  stockReviewRequired: false,
  unitPriceMinor: 10_000,
  taxBasisPoints: 1_800,
  sellBefore: NOW + 30 * 86_400_000,
  ...over,
});
/** Rs 100.00 at 18%; Rs 3.33 at 15% (49.95 cents of tax rounds half-up to 50); under review; expired. */
const A = "batch-a";
const B = "batch-b";
const REVIEW = "batch-review";
const EXPIRED = "batch-expired";
const PANADOL = {
  name: "Panadol",
  strength: "500 mg",
  barcode: "4791111111111",
  batchNo: "PN-01",
};
const PLASTERS = {
  name: "Plasters 10s",
  strength: null,
  barcode: null,
  batchNo: "PL-9",
};
/** A and B carry display text; the other two stand in for a snapshot issued before it existed. */
const lines = [
  line(A, { display: PANADOL }),
  line(B, {
    availableQuantity: 2,
    unitPriceMinor: 333,
    taxBasisPoints: 1_500,
    display: PLASTERS,
  }),
  line(REVIEW, { stockReviewRequired: true }),
  line(EXPIRED, { sellBefore: NOW }),
];

function signed<T>(purpose: "grant" | "snapshot", payload: T): Signed<T> {
  return {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(terminalSigningText(purpose, payload)),
      server.privateKey,
    ).toString("base64url"),
  };
}

function pair(): OfflineAuthority {
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: 1,
    identity,
    generatedAt: NOW - 1_000,
    includedThroughSequence: 0,
    includedThroughHash: null,
    lines,
  };
  const staff = (id: string) => ({
    staffUserId: id,
    staffAuthorizationId: randomUUID(),
    credentialVersion: 1,
    signInMethod: "personal_pin" as const,
    offlineManagerActions: [] as const,
  });
  const grant: OfflineGrant = {
    contractVersion: 1,
    kind: "offline_grant",
    identity,
    ...counter,
    authorizedStaff: [staff(cashier.staffUserId), staff(manager.staffUserId)],
    grantId: randomUUID(),
    grantVersion: 1,
    nominationVersion: 1,
    issuedAt: ISSUED,
    notBefore: ISSUED,
    expiresAt: ISSUED + MAX_OFFLINE_GRANT_MS,
    maxSnapshotAgeAtOutageMs: MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
    currency: "LKR",
    externalCardAllowed: true,
    policyVersion: 1,
    operatingWindows: [{ startsAt: ISSUED, endsAt: NOW + 12 * 3_600_000 }],
    mandatoryOperatingWindows: null,
    operatingHoursException: null,
    receiptNumbering: { prefix: "C1R", nextNumber: receiptFloor },
  };
  return {
    grant: signed("grant", grant),
    snapshot: signed("snapshot", snapshot),
  };
}

function seedDevice(db: PosDatabase): void {
  db.prepare(
    `INSERT INTO device_identity (
      id, status, api_base_url, tenant_id, branch_id, branch_name, terminal_id,
      enrollment_id, key_id, register_id, till_id, counter_label, label,
      public_key_hex, private_key_pkcs8, enrolled_by_user_id, created_at, branch_code
    ) VALUES (1, 'active', 'http://127.0.0.1:3000', ?, ?, '', ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, '')`,
  ).run(
    identity.tenantId,
    identity.branchId,
    identity.terminalId,
    identity.enrollmentId,
    identity.keyId,
    counter.registerId,
    counter.tillId,
    deviceKey.publicKeyHex,
    deviceKey.exportPkcs8(),
    randomUUID(),
    new Date(NOW).toISOString(),
  );
}

let dir: string;
let local: LocalStore;
let up: number;
let wall: number;
let installed: OfflineAuthority;
let staff: OfflineCounterService;
let sale: OfflineSaleService;
let shiftId: string;
let counterMode: "offline" | "online" = "offline";
/** The grant's receipt floor: what the server has already seen from this till. */
let receiptFloor = 1;

const advance = (ms: number) => {
  up += ms;
  wall += ms;
};
/** The counter's trusted time: the grant's signed issue time plus the uptime since. */
const trusted = () => ISSUED + (up - UP0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-offline-sale-"));
  local = openLocalStore(dir, protector, migrations);
  seedDevice(local.db);
  up = UP0;
  counterMode = "offline";
  wall = NOW;
  const clock = new TrustedClock({
    db: local.db,
    uptimeMs: () => up,
    wallMs: () => wall,
  });
  installed = pair();
  expect(
    installOfflineAuthority(local.db, installed, {
      identity,
      ...counter,
      signer,
      trustedNow: NOW,
    }),
  ).toBe("installed");
  clock.observe(ISSUED, "snapshot");
  const pins = new PinStore(local.db);
  for (const person of [cashier, manager])
    pins.save({
      ...person,
      staffName: person.name,
      role: null,
      enrollmentId: identity.enrollmentId,
      pinVersion: 1,
      now: new Date(NOW),
    });
  const writer = new OfflineJournalWriter({
    db: local.db,
    now: () => new Date(wall),
  });
  advance(10_000);
  writer.ensureOfflineOutageSession(identity.enrollmentId, trusted());
  staff = new OfflineCounterService({
    db: local.db,
    device: new DeviceStore(local.db),
    pins,
    journal: writer,
    clock,
    mode: { view: () => ({ mode: counterMode, reason: null }) as never },
  });
  sale = new OfflineSaleService({
    db: local.db,
    counter: staff,
    journal: writer,
  });
  staff.signIn(cashier.staffUserId, cashier.pin);
  shiftId = staff.openShift(cashier.pin, { totalMinor: 10_000, lines: [] })
    .signedIn!.workSessionId;
  advance(1_000);
});

afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function journal(): OfflineJournalCommand[] {
  return (
    local.db
      .prepare(
        "SELECT envelope_json FROM offline_journal_command WHERE enrollment_id = ? ORDER BY sequence",
      )
      .all(identity.enrollmentId) as { envelope_json: string }[]
  ).map(
    (r) =>
      (JSON.parse(r.envelope_json) as Signed<OfflineJournalCommand>).payload,
  );
}
const sales = () =>
  journal().filter((c): c is OfflineSaleCommand => c.kind === "ordinary_sale");

function expectedCash(): number {
  return (
    local.db
      .prepare(
        "SELECT expected_cash_minor FROM till_shift WHERE work_session_id = ?",
      )
      .get(shiftId) as {
      expected_cash_minor: number;
    }
  ).expected_cash_minor;
}

function latestCardState(
  attemptId: string,
): ExternalCardAttemptRecord["state"] {
  const row = local.db
    .prepare(
      "SELECT envelope_json FROM offline_support_record WHERE attempt_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(attemptId) as { envelope_json: string };
  return (JSON.parse(row.envelope_json) as Signed<ExternalCardAttemptRecord>)
    .payload.state;
}

const fails = (run: () => unknown, code: string) =>
  expect(run).toThrow(expect.objectContaining({ code }));
const cart = [
  { snapshotLineId: A, quantity: 2 },
  { snapshotLineId: B, quantity: 1 },
];
/** 2 × Rs 100.00 + 18% = 236.00; 1 × Rs 3.33 + 15% = 3.83. */
const CART_TOTAL = 23_600 + 383;

describe("offline sales (P4 #50)", () => {
  it("lists what the saved stock still lets this counter sell, and why not", () => {
    expect(
      sale.stock().map((l) => [l.snapshotLineId, l.remaining, l.blocked]),
    ).toEqual([
      [A, 5, null],
      [B, 2, null],
      [REVIEW, 5, "STOCK_REVIEW"],
      [EXPIRED, 5, "EXPIRED"],
    ]);
  });

  it("prices a cart at the snapshot's prices with half-up tax per line, and blocks what can't be sold", () => {
    const quote = sale.quote([
      { snapshotLineId: A, quantity: 1 },
      { snapshotLineId: B, quantity: 1 },
      { snapshotLineId: A, quantity: 1 },
      { snapshotLineId: "prescription-batch", quantity: 1 },
      { snapshotLineId: REVIEW, quantity: 1 },
      { snapshotLineId: EXPIRED, quantity: 1 },
    ]);
    expect(
      quote.lines.map((l) => [
        l.snapshotLineId,
        l.quantity,
        l.taxMinor,
        l.lineTotalMinor,
      ]),
    ).toEqual([
      [A, 2, 3_600, 23_600],
      [B, 1, 50, 383],
    ]);
    expect(quote).toMatchObject({
      subtotalMinor: 20_333,
      taxMinor: 3_650,
      totalMinor: CART_TOTAL,
    });
    expect(quote.blocked.map((b) => [b.snapshotLineId, b.reason])).toEqual([
      ["prescription-batch", "NOT_SOLD_OFFLINE"],
      [REVIEW, "STOCK_REVIEW"],
      [EXPIRED, "EXPIRED"],
    ]);
    expect(sale.quote([{ snapshotLineId: B, quantity: 3 }]).blocked).toEqual([
      {
        snapshotLineId: B,
        quantity: 3,
        reason: "NOT_ENOUGH_STOCK",
        remaining: 2,
      },
    ]);
  });

  it("commits a cash sale: journal entry, stock used, drawer, receipt — once per checkout draft", () => {
    const draft = randomUUID();
    const receipt = sale.commit({
      checkoutDraftId: draft,
      items: cart,
      cashTenderedMinor: 30_000,
    });
    expect(receipt).toMatchObject({
      checkoutDraftId: draft,
      sellerName: "Nimal",
      totalMinor: CART_TOTAL,
      changeMinor: 30_000 - CART_TOTAL,
      payments: [
        {
          method: "cash",
          amountMinor: CART_TOTAL,
          tenderedMinor: 30_000,
          changeMinor: 30_000 - CART_TOTAL,
        },
      ],
    });
    const [entry] = sales();
    expect(entry).toMatchObject({
      commandId: receipt.saleCommandId,
      sequence: 2,
      session: { workSessionId: shiftId, staffUserId: cashier.staffUserId },
      snapshotId: installed.snapshot.payload.snapshotId,
      totalMinor: CART_TOTAL,
      lines: [
        {
          snapshotLineId: A,
          quantity: 2,
          unitPriceMinor: 10_000,
          discountMinor: 0,
          taxMinor: 3_600,
        },
        {
          snapshotLineId: B,
          quantity: 1,
          unitPriceMinor: 333,
          discountMinor: 0,
          taxMinor: 50,
        },
      ],
    });
    expect(expectedCash()).toBe(10_000 + CART_TOTAL);
    expect(sale.stock().find((l) => l.snapshotLineId === B)?.remaining).toBe(1);
    // Pay tapped again: the same sale, not a second one.
    expect(
      sale.commit({
        checkoutDraftId: draft,
        items: cart,
        cashTenderedMinor: 30_000,
      }),
    ).toEqual(receipt);
    expect(sales()).toHaveLength(1);
    expect(expectedCash()).toBe(10_000 + CART_TOTAL);
    expect(sale.receipt(receipt.saleCommandId)).toEqual(receipt);
  });

  it("stops selling a batch once this snapshot's stock of it is used up", () => {
    sale.commit({
      checkoutDraftId: randomUUID(),
      items: [{ snapshotLineId: B, quantity: 2 }],
      cashTenderedMinor: 1_000,
    });
    expect(
      sale.quote([{ snapshotLineId: B, quantity: 1 }]).blocked[0]?.reason,
    ).toBe("NOT_ENOUGH_STOCK");
    fails(
      () =>
        sale.commit({
          checkoutDraftId: randomUUID(),
          items: [{ snapshotLineId: B, quantity: 1 }],
          cashTenderedMinor: 1_000,
        }),
      "ITEMS_BLOCKED",
    );
    expect(sales()).toHaveLength(1);
  });

  it("refuses blocked items, short cash and an empty sale, writing nothing", () => {
    fails(
      () =>
        sale.commit({
          checkoutDraftId: randomUUID(),
          items: [{ snapshotLineId: REVIEW, quantity: 1 }],
          cashTenderedMinor: 99_999,
        }),
      "ITEMS_BLOCKED",
    );
    fails(
      () =>
        sale.commit({
          checkoutDraftId: randomUUID(),
          items: cart,
          cashTenderedMinor: CART_TOTAL - 1,
        }),
      "CASH_SHORT",
    );
    fails(
      () =>
        sale.commit({
          checkoutDraftId: randomUUID(),
          items: [],
          cashTenderedMinor: 0,
        }),
      "EMPTY_SALE",
    );
    expect(sales()).toHaveLength(0);
    expect(expectedCash()).toBe(10_000);
  });

  it("takes a card for part and cash for the rest, only once the card payment is settled", () => {
    const draft = randomUUID();
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: draft,
      items: cart,
      amountMinor: 20_000,
    });
    // The card machine hasn't answered yet: no sale, and no second card payment.
    fails(
      () =>
        sale.commit({
          checkoutDraftId: draft,
          items: cart,
          cashTenderedMinor: 5_000,
        }),
      "CARD_UNRESOLVED",
    );
    fails(
      () =>
        sale.prepareCard({
          checkoutDraftId: draft,
          items: cart,
          amountMinor: 20_000,
        }),
      "ATTEMPT_UNRESOLVED",
    );
    advance(20_000);
    sale.recordCardOutcome({
      attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-778",
        approvalCode: "A1B2",
        approvedAt: trusted(),
      },
    });
    advance(5_000);
    const receipt = sale.commit({
      checkoutDraftId: draft,
      items: cart,
      cashTenderedMinor: 5_000,
    });
    expect(receipt.payments).toEqual([
      {
        method: "external_card",
        amountMinor: 20_000,
        providerReference: "RRN-778",
        approvalCode: "A1B2",
        approvedAt: expect.any(Number),
      },
      {
        method: "cash",
        amountMinor: CART_TOTAL - 20_000,
        tenderedMinor: 5_000,
        changeMinor: 5_000 - (CART_TOTAL - 20_000),
      },
    ]);
    expect(latestCardState(attemptId)).toBe("linked_to_sale");
    // Only the cash part lands in the drawer.
    expect(expectedCash()).toBe(10_000 + CART_TOTAL - 20_000);
  });

  it("won't finish a different cart with a card approved for another", () => {
    const draft = randomUUID();
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: draft,
      items: cart,
      amountMinor: CART_TOTAL,
    });
    sale.recordCardOutcome({
      attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-1",
        approvalCode: "OK",
        approvedAt: trusted(),
      },
    });
    advance(1_000);
    fails(
      () =>
        sale.commit({
          checkoutDraftId: draft,
          items: [{ snapshotLineId: A, quantity: 2 }],
          cashTenderedMinor: 0,
        }),
      "CARD_FOR_OTHER_CART",
    );
    expect(latestCardState(attemptId)).toBe("approved");
    expect(sales()).toHaveLength(0);
  });

  it("lets a card no sale will use be recorded as not used, then takes a new card for the changed cart", () => {
    const draft = randomUUID();
    const first = sale.prepareCard({
      checkoutDraftId: draft,
      items: cart,
      amountMinor: CART_TOTAL,
    });
    sale.recordCardOutcome({
      attemptId: first.attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-1",
        approvalCode: "OK",
        approvedAt: trusted(),
      },
    });
    advance(1_000);
    // The customer drops an item: the approved card no longer fits the cart.
    const smaller = [{ snapshotLineId: A, quantity: 2 }];
    fails(
      () =>
        sale.commit({
          checkoutDraftId: draft,
          items: smaller,
          cashTenderedMinor: 0,
        }),
      "CARD_FOR_OTHER_CART",
    );
    sale.recordCardOutcome({
      attemptId: first.attemptId,
      outcome: {
        kind: "not_used",
        settlement: "reversed_on_machine",
        reversalReference: "VOID-1",
        reason: "Customer took one item off",
      },
    });
    expect(latestCardState(first.attemptId)).toBe("not_used");
    const second = sale.prepareCard({
      checkoutDraftId: draft,
      items: smaller,
      amountMinor: 23_600,
    });
    sale.recordCardOutcome({
      attemptId: second.attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-2",
        approvalCode: "OK2",
        approvedAt: trusted(),
      },
    });
    advance(1_000);
    const receipt = sale.commit({
      checkoutDraftId: draft,
      items: smaller,
      cashTenderedMinor: 0,
    });
    expect(receipt.payments).toEqual([
      expect.objectContaining({
        method: "external_card",
        providerReference: "RRN-2",
      }),
    ]);
    expect(latestCardState(first.attemptId)).toBe("not_used");
    expect(latestCardState(second.attemptId)).toBe("linked_to_sale");
  });

  it("keeps an unsettled card with its cart, so Sell can show it again, and holds everything else until it's settled", () => {
    expect(sale.openCard()).toBeNull();
    const draft = randomUUID();
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: draft,
      items: cart,
      amountMinor: CART_TOTAL,
    });
    expect(sale.openCard()).toEqual({
      checkoutDraftId: draft,
      items: cart,
      totalMinor: CART_TOTAL,
      attempt: {
        attemptId,
        amountMinor: CART_TOTAL,
        state: "prepared",
        reference: null,
        approvalCode: null,
      },
    });
    sale.recordCardOutcome({
      attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-9",
        approvalCode: "OK9",
        approvedAt: trusted(),
      },
    });
    expect(sale.openCard()?.attempt).toMatchObject({
      state: "approved",
      reference: "RRN-9",
      approvalCode: "OK9",
    });
    // Another sale can't start a card, and the shift can't close, while this one is open.
    fails(
      () =>
        sale.prepareCard({
          checkoutDraftId: randomUUID(),
          items: cart,
          amountMinor: 100,
        }),
      "CARD_UNRESOLVED",
    );
    fails(
      () => staff.closeShift({ totalMinor: 10_000, lines: [] }),
      "CARD_UNRESOLVED",
    );
    advance(1_000);
    sale.commit({ checkoutDraftId: draft, items: cart, cashTenderedMinor: 0 });
    expect(sale.openCard()).toBeNull();
  });

  it("settles an approved card as not used after the counter has come back online", () => {
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: randomUUID(),
      items: cart,
      amountMinor: CART_TOTAL,
    });
    sale.recordCardOutcome({
      attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-5",
        approvalCode: "OK",
        approvedAt: trusted(),
      },
    });
    advance(1_000);
    // Back online, the drain waits on this payment; selling offline is over.
    counterMode = "online";
    fails(
      () =>
        sale.prepareCard({
          checkoutDraftId: randomUUID(),
          items: cart,
          amountMinor: 100,
        }),
      "ONLINE",
    );
    sale.recordCardOutcome({
      attemptId,
      outcome: {
        kind: "not_used",
        settlement: "refund_owed",
        reversalReference: null,
        reason: "Sale abandoned when the power went",
      },
    });
    expect(latestCardState(attemptId)).toBe("not_used");
  });

  it("leaves a declined card out and lets the customer pay cash", () => {
    const draft = randomUUID();
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: draft,
      items: cart,
      amountMinor: CART_TOTAL,
    });
    sale.recordCardOutcome({
      attemptId,
      outcome: { kind: "declined", reference: "RRN-9" },
    });
    const receipt = sale.commit({
      checkoutDraftId: draft,
      items: cart,
      cashTenderedMinor: CART_TOTAL,
    });
    expect(receipt.payments.map((p) => p.method)).toEqual(["cash"]);
    expect(latestCardState(attemptId)).toBe("declined");
  });

  it("refuses a card for more than is left to pay", () => {
    fails(
      () =>
        sale.prepareCard({
          checkoutDraftId: randomUUID(),
          items: cart,
          amountMinor: CART_TOTAL + 1,
        }),
      "CARD_OVER_TOTAL",
    );
  });

  it("sells only under the signed-in person's own open shift", () => {
    staff.signIn(manager.staffUserId, manager.pin);
    fails(() => sale.quote(cart), "SHIFT_NOT_OPEN");
    fails(
      () =>
        sale.commit({
          checkoutDraftId: randomUUID(),
          items: cart,
          cashTenderedMinor: CART_TOTAL,
        }),
      "SHIFT_NOT_OPEN",
    );
  });

  it("writes sales the server's replay accepts, entry by entry, with usage carried between them", () => {
    sale.commit({
      checkoutDraftId: randomUUID(),
      items: cart,
      cashTenderedMinor: 30_000,
    });
    advance(10_000);
    const draft = randomUUID();
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: draft,
      items: [{ snapshotLineId: A, quantity: 3 }],
      amountMinor: 35_400,
    });
    sale.recordCardOutcome({
      attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-2",
        approvalCode: "OK2",
        approvedAt: trusted(),
      },
    });
    advance(10_000);
    sale.commit({
      checkoutDraftId: draft,
      items: [{ snapshotLineId: A, quantity: 3 }],
    });

    const grant = installed.grant.payload;
    const snapshot = installed.snapshot.payload;
    const signInRows = local.db
      .prepare("SELECT envelope_json FROM offline_journal_staff_sign_in")
      .all() as { envelope_json: string }[];
    const signIns = new Map(
      signInRows.map((r) => {
        const p = (JSON.parse(r.envelope_json) as Signed<OfflineStaffSignIn>)
          .payload;
        return [p.staffSignInId, p];
      }),
    );
    const open = journal().find(
      (c): c is OfflineShiftOpenCommand => c.kind === "shift_open",
    )!;
    const quantities: Record<string, number> = {};
    for (const entry of sales()) {
      const error = offlineSalePolicyError(
        grant,
        snapshot,
        entry,
        {
          grantId: grant.grantId,
          grantVersion: grant.grantVersion,
          snapshotId: snapshot.snapshotId,
          snapshotVersion: snapshot.snapshotVersion,
          offlineSessionId: entry.offlineSessionId,
          offlineStartedAt: entry.offlineStartedAt,
          quantities: { ...quantities },
        },
        entry.occurredAt,
        "offline",
        signIns.get(entry.staffSignInId)!,
        {
          identity,
          session: open.session,
          openedAt: open.occurredAt,
          openingCashMinor: open.openingCashMinor,
        },
      );
      expect(error).toBeNull();
      for (const l of entry.lines)
        quantities[l.snapshotLineId] =
          (quantities[l.snapshotLineId] ?? 0) + l.quantity;
    }
    expect(quantities).toEqual({ [A]: 5, [B]: 1 });
    expect(sale.stock().find((l) => l.snapshotLineId === A)?.remaining).toBe(0);
  });

  it("names each line from the signed snapshot, and falls back to the batch for an older one", () => {
    const stock = new Map(
      sale.stock().map((l) => [l.snapshotLineId, l.display]),
    );
    expect(stock.get(A)).toEqual(PANADOL);
    expect(stock.get(REVIEW)).toBeNull();
    const quote = sale.quote(cart);
    expect(quote.lines.map(offlineLineLabel)).toEqual([
      "Panadol 500 mg",
      "Plasters 10s",
    ]);
    expect(offlineLineLabel({ batchId: REVIEW, display: null })).toBe(
      "Item, batch batch-re",
    );
    // A name already ending in its strength isn't doubled.
    expect(
      offlineLineLabel({
        batchId: A,
        display: { ...PANADOL, name: "Panadol 500 mg" },
      }),
    ).toBe("Panadol 500 mg");
  });

  it("numbers each sale under the till's prefix, in order, and signs the number into the sale", () => {
    const numbers = [1, 2, 3].map(() => {
      const draft = randomUUID();
      const receipt = sale.commit({
        checkoutDraftId: draft,
        items: [{ snapshotLineId: A, quantity: 1 }],
        cashTenderedMinor: 20_000,
      });
      advance(1_000);
      // A second tap on Pay gives the same sale, not a new number.
      expect(
        sale.commit({
          checkoutDraftId: draft,
          items: [{ snapshotLineId: A, quantity: 1 }],
          cashTenderedMinor: 20_000,
        }).receiptNumber,
      ).toBe(receipt.receiptNumber);
      return receipt.receiptNumber;
    });
    expect(numbers).toEqual(["C1R-000001", "C1R-000002", "C1R-000003"]);
    expect(sales().map((s) => s.receiptNumber)).toEqual(numbers);
  });

  it("never reuses a number this store gave, even once its journal entry is set aside", () => {
    // A recovery may set journal entries aside; the receipts the customers hold stay on record.
    local.db
      .prepare(
        "INSERT INTO offline_sale_receipt (checkout_draft_id, enrollment_id, command_id, receipt_number, receipt_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)",
      )
      .run(
        randomUUID(),
        identity.enrollmentId,
        randomUUID(),
        "C1R-000041",
        new Date(NOW).toISOString(),
      );
    const receipt = sale.commit({
      checkoutDraftId: randomUUID(),
      items: [{ snapshotLineId: A, quantity: 1 }],
      cashTenderedMinor: 20_000,
    });
    expect(receipt.receiptNumber).toBe("C1R-000042");
  });

  it("shows readiness the number the next offline sale actually gets", () => {
    // As the readiness check reads it: the installed grant's numbering over this store.
    const shown = () =>
      nextOfflineReceiptNumber(
        local.db,
        readInstalledOfflineAuthority(local.db, identity.enrollmentId)!.grant
          .payload.receiptNumbering,
      );
    for (let i = 0; i < 2; i++) {
      const before = shown();
      const receipt = sale.commit({
        checkoutDraftId: randomUUID(),
        items: [{ snapshotLineId: A, quantity: 1 }],
        cashTenderedMinor: 20_000,
      });
      advance(1_000);
      expect(receipt.receiptNumber).toBe(before);
    }
    expect(shown()).toBe("C1R-000003");
  });

  describe("on a counter the server has seen sales from before", () => {
    beforeAll(() => {
      receiptFloor = 186;
    });
    afterAll(() => {
      receiptFloor = 1;
    });

    it("starts from the grant's floor, so a replaced counter never repeats a number", () => {
      const receipt = sale.commit({
        checkoutDraftId: randomUUID(),
        items: [{ snapshotLineId: A, quantity: 1 }],
        cashTenderedMinor: 20_000,
      });
      expect(receipt.receiptNumber).toBe("C1R-000186");
    });
  });

  it("keeps a card left on the machine across a restart, still holding the reconnect drain", () => {
    const draft = randomUUID();
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: draft,
      items: cart,
      amountMinor: CART_TOTAL,
    });
    // A fresh service over the same store, as after the app restarts: nothing is lost or settled.
    const again = new OfflineSaleService({
      db: local.db,
      counter: staff,
      journal: {
        appendSignedCommand: () => undefined,
        getBatchUsageQuantities: () => ({}),
      } as never,
    });
    expect(again.openCard()).toMatchObject({
      checkoutDraftId: draft,
      items: cart,
      attempt: { attemptId, state: "prepared" },
    });
    expect(drainHolds(local.db, identity.enrollmentId).cards).toBe(1);
  });

  it("saves the whole sale or none of it when the disk fills up", () => {
    const before = {
      sales: sales().length,
      cash: expectedCash(),
      receipts: (
        local.db
          .prepare("SELECT COUNT(*) AS n FROM offline_sale_receipt")
          .get() as { n: number }
      ).n,
    };
    // No room for one more page: the sale's first write fails, as on a full disk.
    const pages =
      (local.db.pragma("page_count", { simple: true }) as number) ?? 0;
    local.db.pragma(`max_page_count = ${pages}`);
    let thrown: unknown;
    try {
      for (let i = 0; i < 50; i++)
        sale.commit({
          checkoutDraftId: randomUUID(),
          items: [{ snapshotLineId: A, quantity: 1 }],
          cashTenderedMinor: 100_000,
        });
    } catch (error) {
      thrown = error;
    } finally {
      local.db.pragma("max_page_count = 1073741823");
    }
    expect((thrown as { code?: string }).code).toBe("SQLITE_FULL");
    const receipts = (
      local.db
        .prepare("SELECT COUNT(*) AS n FROM offline_sale_receipt")
        .get() as { n: number }
    ).n;
    // Every sale that was saved is whole: one journal entry, one receipt, its cash, each.
    const saved = receipts - before.receipts;
    expect(sales().length - before.sales).toBe(saved);
    expect(expectedCash() - before.cash).toBe(saved * 11_800);
  });

  it("remembers that a receipt printed, so every later print is a reprint, even after a restart", () => {
    const receipt = sale.commit({
      checkoutDraftId: randomUUID(),
      items: cart,
      cashTenderedMinor: CART_TOTAL,
    });
    expect(sale.printedBefore(receipt.saleCommandId)).toBe(false);
    sale.markPrinted(receipt.saleCommandId, new Date(1_000));
    sale.markPrinted(receipt.saleCommandId, new Date(2_000));
    // Read back by a fresh service over the same store, as after an app restart.
    const again = new OfflineSaleService({
      db: local.db,
      counter: staff,
      journal: {
        appendSignedCommand: () => undefined,
        getBatchUsageQuantities: () => ({}),
      } as never,
    });
    expect(again.printedBefore(receipt.saleCommandId)).toBe(true);
    expect(
      local.db
        .prepare(
          "SELECT printed_at FROM offline_sale_receipt WHERE command_id = ?",
        )
        .get(receipt.saleCommandId),
    ).toEqual({ printed_at: new Date(1_000).toISOString() });
  });

  it("prints an offline receipt as a normal one, under its final receipt number", () => {
    const draft = randomUUID();
    const { attemptId } = sale.prepareCard({
      checkoutDraftId: draft,
      items: cart,
      amountMinor: 20_000,
    });
    sale.recordCardOutcome({
      attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN-5",
        approvalCode: "OK",
        approvedAt: trusted(),
      },
    });
    advance(1_000);
    const receipt = sale.commit({
      checkoutDraftId: draft,
      items: cart,
      cashTenderedMinor: 5_000,
    });
    const printed = offlineReceiptForPrinting(receipt);
    expect(printed).toMatchObject({
      invoiceNo: "C1R-000001",
      sellerName: "Nimal",
      subtotal: "203.33",
      taxTotal: "36.50",
      grandTotal: "239.83",
      amountPaid: "250.00",
      changeDue: "10.17",
      lines: [
        {
          name: "Panadol 500 mg (batch PN-01)",
          qty: 2,
          unitPrice: "100.00",
          lineTotal: "236.00",
        },
        {
          name: "Plasters 10s (batch PL-9)",
          qty: 1,
          unitPrice: "3.33",
          lineTotal: "3.83",
        },
      ],
      payments: [
        { method: "card", amount: "200.00", reference: "RRN-5" },
        { method: "cash", amount: "50.00", reference: null },
      ],
    });
    const html = renderSaleReceiptHtml(printed, {
      branchName: "Kandy",
      counterLabel: "Till 1",
    });
    expect(html).toContain("Panadol 500 mg (batch PN-01)");
    expect(html).toContain("RRN-5");
  });
});
