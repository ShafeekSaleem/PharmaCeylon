import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  terminalSigningText,
  type BranchStockSnapshot,
  type OfflineGrant,
  type Signed,
} from "@pharmaceylon/shared";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import type { Logger } from "../logging/logger";
import { installOfflineAuthority } from "../terminal/offline-authority";
import { OfflineJournalWriter } from "../terminal/offline-journal-writer";
import type { TerminalService } from "../terminal/terminal-service";
import { CheckoutService } from "./checkout-service";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (plain) => Buffer.from(plain, "utf8"),
  unprotect: (blob) => blob.toString("utf8"),
};
const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  flush: async () => {},
};
const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const deviceKey = DeviceKey.generate();
const branchId = randomUUID();
const sellerStaffUserId = randomUUID();
let signedIn = { staffUserId: sellerStaffUserId, workSessionId: randomUUID() };
const paracetamol = randomUUID();
const NOW = Date.UTC(2026, 10, 4, 10, 0);
const counter = { registerId: randomUUID(), tillId: randomUUID() };

let identity = {
  tenantId: randomUUID(),
  branchId,
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};
let batchId = randomUUID();
let journalFails = false;
let dir: string;
let local: LocalStore;
let offlineJournal: OfflineJournalWriter;
let checkoutReply: () => unknown;
let resolveReply: () => unknown;

function signedServer<T>(purpose: "grant" | "snapshot", payload: T): Signed<T> {
  return {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    payload,
    signature: sign(null, Buffer.from(terminalSigningText(purpose, payload)), server.privateKey).toString("base64url"),
  };
}

function installAuthority(): void {
  const issuedAt = NOW - 5_000;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: 1,
    identity,
    generatedAt: issuedAt - 1_000,
    includedThroughSequence: 0,
    includedThroughHash: null,
    lines: [
      {
        snapshotLineId: batchId,
        productId: paracetamol,
        batchId,
        availableQuantity: 100,
        stockReviewRequired: false,
        unitPriceMinor: 250,
        taxBasisPoints: 0,
        sellBefore: NOW + 86_400_000 * 90,
      },
    ],
  };
  const grant: OfflineGrant = {
    contractVersion: 1,
    kind: "offline_grant",
    identity,
    ...counter,
    authorizedStaff: [
      {
        staffUserId: sellerStaffUserId,
        staffAuthorizationId: randomUUID(),
        credentialVersion: 1,
        signInMethod: "personal_pin",
        offlineManagerActions: [],
      },
    ],
    grantId: randomUUID(),
    grantVersion: 1,
    nominationVersion: 1,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + MAX_OFFLINE_GRANT_MS,
    maxSnapshotAgeAtOutageMs: MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
    currency: "LKR",
    externalCardAllowed: true,
    policyVersion: 1,
    operatingWindows: [{ startsAt: issuedAt, endsAt: issuedAt + MAX_OFFLINE_GRANT_MS }],
    mandatoryOperatingWindows: null,
    operatingHoursException: null,
  };
  installOfflineAuthority(
    local.db,
    { grant: signedServer("grant", grant), snapshot: signedServer("snapshot", snapshot) },
    { identity, ...counter, signer, trustedNow: NOW },
  );
}

const catalogResponse = {
  products: [
    {
      id: paracetamol,
      sku: "P500",
      name: "Paracetamol",
      barcode: "4790001",
      strength: "500mg",
      unit: "tab",
      isControlled: false,
      requiresPrescription: false,
      qtyOnHand: 10,
      batches: [{ sellingPrice: "2.50", qtyOnHand: 10 }],
    },
  ],
  departments: [],
  vatRatePercent: 0,
};

function saleWithBatch(id = randomUUID()) {
  return {
    id,
    invoiceNo: "INV-OJ-42",
    soldAt: new Date(NOW).toISOString(),
    subtotal: "5.00",
    taxTotal: "0.00",
    discountTotal: "0.00",
    grandTotal: "5.00",
    amountPaid: "10.00",
    changeDue: "5.00",
    items: [
      {
        qty: 2,
        unitPrice: "2.50",
        lineTotal: "5.00",
        product: { name: "Paracetamol", id: paracetamol },
        batch: { id: batchId },
      },
    ],
    payments: [{ method: "cash", amount: "10.00", reference: null }],
    seller: { fullName: "Cashier" },
  };
}

function checkoutService(): CheckoutService {
  const api = {
    request: async (_method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) => {
      if (path === "/sales/pos/catalog") return catalogResponse;
      if (path === "/sales/checkout") return checkoutReply();
      if (path === "/sales/checkout/resolve") return resolveReply();
      throw new Error(path);
    },
  };
  const terminal = {
    current: () => ({
      staff: { ...signedIn, staffName: "Cashier", openedAt: "" },
      identity,
    }),
  };
  const journal = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW) });
  const record = journal.recordOnlineSaleLinesIfNew.bind(journal);
  journal.recordOnlineSaleLinesIfNew = (...args) => {
    if (journalFails) throw new Error("JOURNAL_WRITE_FAILED");
    return record(...args);
  };
  offlineJournal = journal;
  return new CheckoutService({
    db: local.db,
    api: api as unknown as ApiSession,
    terminal: terminal as unknown as TerminalService,
    logger,
    offlineJournal: journal,
  });
}

function usageQty(): number {
  const row = local.db
    .prepare(
      `SELECT qty_sold FROM offline_journal_batch_usage
       WHERE enrollment_id = ? AND batch_id = ?`,
    )
    .get(identity.enrollmentId, batchId) as { qty_sold: number } | undefined;
  return row?.qty_sold ?? 0;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-checkout-offline-journal-"));
  local = openLocalStore(dir, protector, migrations);
  batchId = randomUUID();
  identity = { ...identity, enrollmentId: randomUUID() };
  journalFails = false;
  local.db.prepare("DELETE FROM device_identity WHERE id = 1").run();
  local.db
    .prepare(
      `INSERT INTO device_identity (
        id, status, api_base_url, tenant_id, branch_id, branch_name, terminal_id,
        enrollment_id, key_id, register_id, till_id, counter_label, label,
        public_key_hex, private_key_pkcs8, enrolled_by_user_id, created_at, branch_code
      ) VALUES (1, 'active', 'http://127.0.0.1', ?, ?, '', ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, '')`,
    )
    .run(
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
  installAuthority();
  checkoutReply = () => saleWithBatch();
  resolveReply = () => {
    throw new Error("not expected");
  };
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("CheckoutService offline journal integration", () => {
  it("rolls back draft completion when journal usage recording throws", async () => {
    const checkout = checkoutService();
    await checkout.catalog();
    const saleId = randomUUID();
    journalFails = true;
    checkoutReply = () => saleWithBatch(saleId);
    await expect(checkout.submit([{ productId: paracetamol, qty: 2 }], { cashAmount: "10" })).rejects.toThrow(
      "JOURNAL_WRITE_FAILED",
    );
    expect(local.db.prepare("SELECT status, sale_id FROM checkout_draft").get()).toMatchObject({
      status: expect.not.stringMatching(/^completed$/),
      sale_id: null,
    });
    expect(usageQty()).toBe(0);
    expect(
      local.db.prepare("SELECT 1 FROM offline_journal_online_sale_record WHERE sale_id = ?").get(saleId),
    ).toBeUndefined();
  });

  it("records batch usage once when resolve lands a sale after journal write had failed on submit", async () => {
    const checkout = checkoutService();
    await checkout.catalog();
    const saleId = randomUUID();
    journalFails = true;
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(checkout.submit([{ productId: paracetamol, qty: 2 }], { cashAmount: "10" })).rejects.toMatchObject({
      code: "CHECKOUT_UNCERTAIN",
    });
    const [pending] = checkout.pending();
    journalFails = false;
    resolveReply = () => ({ outcome: "landed", sale: saleWithBatch(saleId) });
    signedIn = { staffUserId: randomUUID(), workSessionId: randomUUID() };
    await checkout.retry(pending!.draftId);
    expect(usageQty()).toBe(2);
    expect(
      local.db.prepare("SELECT COUNT(*) AS n FROM offline_journal_online_sale_record WHERE sale_id = ?").get(saleId),
    ).toEqual({ n: 1 });
    await expect(checkout.retry(pending!.draftId)).rejects.toMatchObject({ code: "DRAFT_NOT_PENDING" });
    expect(usageQty()).toBe(2);
  });

  it("completes the draft and records usage once when the seller retries after journal failure on first send", async () => {
    const checkout = checkoutService();
    await checkout.catalog();
    const saleId = randomUUID();
    journalFails = true;
    checkoutReply = () => saleWithBatch(saleId);
    await expect(checkout.submit([{ productId: paracetamol, qty: 2 }], { cashAmount: "10" })).rejects.toThrow(
      "JOURNAL_WRITE_FAILED",
    );
    const [pending] = checkout.pending();
    journalFails = false;
    await checkout.retry(pending!.draftId);
    expect(local.db.prepare("SELECT status, sale_id FROM checkout_draft").get()).toEqual({
      status: "completed",
      sale_id: saleId,
    });
    expect(usageQty()).toBe(2);
    checkoutReply = () => saleWithBatch(saleId);
    await expect(checkout.retry(pending!.draftId)).rejects.toMatchObject({ code: "DRAFT_NOT_PENDING" });
    expect(usageQty()).toBe(2);
  });

  it("does not double-count usage when the seller retries after the server already landed the sale", async () => {
    const checkout = checkoutService();
    await checkout.catalog();
    const saleId = randomUUID();
    checkoutReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(checkout.submit([{ productId: paracetamol, qty: 2 }], { cashAmount: "10" })).rejects.toMatchObject({
      code: "CHECKOUT_UNCERTAIN",
    });
    const [pending] = checkout.pending();
    checkoutReply = () => saleWithBatch(saleId);
    await checkout.retry(pending!.draftId);
    expect(usageQty()).toBe(2);
    checkoutReply = () => saleWithBatch(saleId);
    await expect(checkout.retry(pending!.draftId)).rejects.toMatchObject({ code: "DRAFT_NOT_PENDING" });
    expect(usageQty()).toBe(2);
  });
});
