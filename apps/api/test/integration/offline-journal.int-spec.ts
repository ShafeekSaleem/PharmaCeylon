import { generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { Prisma, RoleName, StockMovementType } from "@prisma/client";
import {
  defaultCounterPolicy,
  terminalSigningText,
  type BranchStockSnapshot,
  type LocalAttendanceAttestation,
  type OfflineGrant,
  type OfflineJournalCommand,
  type OfflinePayment,
  type OfflineSaleCommand,
  type OfflineShiftCloseCommand,
  type OfflineShiftOpenCommand,
  type OfflineStaffSignIn,
  type OnlineTerminalCommand,
  type Signed,
  type SyncAcknowledgement,
  type SyncRequest,
  type TerminalEnrollmentCommand,
  type TerminalIdentity,
  type TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import { BusinessHoursAcknowledgements } from "../../src/terminals/business-hours-acknowledgements.service";
import { OfflineJournalService } from "../../src/terminals/journal/offline-journal.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import { OfflineActivationClearance, OfflineActivationService } from "../../src/terminals/offline-activation.service";
import { OfflineAssignmentService } from "../../src/terminals/offline-assignment.service";
import { emptyJournalState, issueOfflineAuthority } from "../../src/terminals/offline-authority-issuance";
import { OfflineSupportRecords } from "../../src/terminals/offline-support-records.service";
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import { TillShiftsService } from "../../src/terminals/shifts/till-shifts.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, commandText, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

/** P5 #51: the nominated counter's offline journal, uploaded and accepted against PostgreSQL. */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
const proofs = new AttendanceProofsService(prisma as never, access);
const assignments = new OfflineAssignmentService(prisma as never, access, audit);
const activation = new OfflineActivationService(prisma as never, trust, assignments, new OfflineActivationClearance(), audit);
const stock = new StockService();
const shifts = new TillShiftsService(prisma as never, trust, new OperatingHoursEvidence(), access, audit, {} as never);
const sales = new SalesService(
  prisma as never, audit, new TaxService({ get: () => "18" } as never), {} as never,
  { assertCanSell: async () => undefined } as never, stock,
);

const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-journal-it", privateKey: server.privateKey };
const config = {
  get: (key: string) =>
    key === "OFFLINE_AUTHORITY_KEY_ID" ? signer.keyId
      : key === "OFFLINE_AUTHORITY_PRIVATE_KEY" ? (server.privateKey.export({ format: "pem", type: "pkcs8" }) as string)
        : undefined,
};
const journal = new OfflineJournalService(
  prisma as never, access, audit, stock,
  new OfflineSupportRecords(access, audit, new BusinessHoursAcknowledgements(access, audit)),
  shifts, config as never,
);

type Device = ReturnType<typeof terminalDevice>;

/** One branch with its own nominated offline counter, prepared staff, stock and issued authority. */
type Counter = {
  fx: TenantFixture;
  owner: RequestUser;
  manager: RequestUser;
  cashier: RequestUser;
  device: Device;
  identity: TerminalIdentity;
  grant: OfflineGrant;
  snapshot: BranchStockSnapshot;
  /** Batches in the snapshot, by name. */
  batches: Record<string, string>;
};

function user(fx: TenantFixture, userId: string): RequestUser {
  return { userId, tenantId: fx.tenantId, tokenVersion: 0, email: "t@example.test", fullName: "T", authMethod: "bearer", branchRoles: [] };
}

function attest(
  fx: TenantFixture,
  challenge: TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>,
  purpose: LocalAttendanceAttestation["purpose"],
  actor: RequestUser,
): LocalAttendanceAttestation {
  const counter = challenge.kind === "terminal_enrollment"
    ? { registerId: challenge.registerId, tillId: challenge.tillId }
    : { registerId: challenge.session.registerId, tillId: challenge.session.tillId };
  return {
    contractVersion: 1, kind: "local_attendance", proofId: randomUUID(), purpose,
    identity: challenge.identity, actorUserId: actor.userId, ...counter,
    payloadDigest: sha256(boundedCanonical(challenge)),
    windowsSession: { sessionId: 1, protocol: "console", remoteSession: false },
    appVersion: "0.0.1", observedAt: Date.now(),
  };
}

async function stockedBatch(fx: TenantFixture, qty: number) {
  const row = await prisma.batch.create({
    data: {
      tenantId: fx.tenantId, branchId: fx.mainBranchId, productId: fx.productId, batchNo: `B-${randomUUID().slice(0, 6)}`,
      expiryDate: daysFromToday(365), costPrice: "10.00", sellingPrice: "15.50", supplierId: fx.supplierId,
    },
  });
  await prisma.$transaction((t) => stock.receive(
    t,
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
    [{ productId: fx.productId, batchId: row.id, qty, movementType: StockMovementType.opening_stock }],
  ));
  return row.id;
}

async function counter(stockByBatch: Record<string, number> = { main: 40 }): Promise<Counter> {
  const fx = await createTenant(prisma, "offline-journal");
  const [owner, manager, cashier] = [fx.ownerId, fx.managerId, fx.clerkId].map((id) => user(fx, id));
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: RoleName.manager },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
    ],
  });
  const open24 = { mode: "open_24h" as const };
  await prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: {
      counterPolicy: { ...defaultCounterPolicy(), offlineEnabled: true } as unknown as Prisma.InputJsonValue,
      operatingHours: {
        schemaVersion: 1,
        weekly: { mon: open24, tue: open24, wed: open24, thu: open24, fri: open24, sat: open24, sun: open24 },
        exceptions: [], mandatory: null,
      } as unknown as Prisma.InputJsonValue,
      operatingHoursOrigin: "editor",
    },
  });
  const batches: Record<string, string> = {};
  for (const [name, qty] of Object.entries(stockByBatch)) batches[name] = await stockedBatch(fx, qty);

  // Enroll, then nominate through revised D13 (remote authorization, local activation).
  const device = terminalDevice();
  const proof = (a: LocalAttendanceAttestation, actor: RequestUser) =>
    proofs.record(actor, fx.mainBranchId, device.sign(a, a.identity.keyId, "attendance"));
  const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
  const register = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, "Front"));
  const enrollment = await tx((c) => trust.beginEnrollment(c, owner, fx.mainBranchId, {
    registerId: register.id, keyId: randomUUID(), publicKeyHex: device.publicKeyHex, label: "PC",
  }));
  const ep = await proof(attest(fx, enrollment, "enrollment", owner), owner);
  const identity = await tx((c) => trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(enrollment, enrollment.identity.keyId), ep.proofId));
  const session = await tx((c) => trust.beginSession(c, manager, fx.mainBranchId, identity));
  const sp = await proof(attest(fx, session, "session", manager), manager);
  const { workSessionId } = await tx((c) => trust.finishSession(c, manager, fx.mainBranchId, device.sign(session, identity.keyId), sp.proofId));
  const authorizationId = randomUUID();
  await assignments.authorize(owner, fx.mainBranchId, {
    authorizationId, targetTerminalId: identity.terminalId, targetEnrollmentId: identity.enrollmentId,
    expectedNominationVersion: 0, reason: "Front counter keeps selling during outages",
  });
  const command = await activation.prepare(manager, fx.mainBranchId, { workSessionId, authorizationId, expectedNominationVersion: 0 });
  const ap = await proof(attest(fx, command, "command", manager), manager);
  await activation.activate(manager, fx.mainBranchId, { envelope: device.sign(command, identity.keyId), attendanceProofId: ap.proofId });

  // Personal offline PINs prepared on this counter for the cashier and the manager.
  for (const staffUserId of [cashier.userId, manager.userId]) {
    await prisma.appUser.update({ where: { id: staffUserId }, data: { posPinHash: "prepared-in-test", posPinVersion: 1 } });
    await prisma.terminalStaffPreparation.create({
      data: { ...identity, id: undefined, staffUserId, pinVersion: 1 },
    });
  }
  const issued = await issueOfflineAuthority(prisma as never, access, {
    signer, defaultVatRatePercent: 18,
    authenticate: async () => ({ identity, commandId: randomUUID() }),
    readState: emptyJournalState,
  });
  return { fx, owner, manager, cashier, device, identity, grant: issued.grant.payload, snapshot: issued.snapshot.payload, batches };
}

/**
 * The counter's side: a durable offline journal. Each entry takes the next sequence and names
 * the previous entry's hash, exactly as P4 will write it.
 */
function offlineJournal(c: Counter) {
  let sequence = 0;
  let previous: string | null = null;
  const offlineStartedAt = Math.max(c.snapshot.generatedAt, c.grant.notBefore) + 1;
  const offlineSessionId = randomUUID();
  let clock = offlineStartedAt;
  const till = { registerId: c.grant.registerId, tillId: c.grant.tillId };
  const signIn = (staffUserId: string, workSessionId: string): Signed<OfflineStaffSignIn> => {
    const staff = c.grant.authorizedStaff.find((s) => s.staffUserId === staffUserId)!;
    return c.device.sign({
      contractVersion: 1, kind: "offline_staff_sign_in", staffSignInId: randomUUID(), identity: c.identity,
      session: { ...till, workSessionId, staffUserId }, grantId: c.grant.grantId, grantVersion: c.grant.grantVersion,
      staffAuthorizationId: staff.staffAuthorizationId, credentialVersion: staff.credentialVersion,
      method: "personal_pin", authenticatedAt: offlineStartedAt,
    } satisfies OfflineStaffSignIn, c.identity.keyId);
  };
  function entry<T extends OfflineJournalCommand>(
    staff: Signed<OfflineStaffSignIn>,
    body: Omit<T, keyof Omit<OfflineJournalCommand, "kind">> & Partial<OfflineJournalCommand>,
    overrides: Partial<OfflineJournalCommand> = {},
  ): Signed<T> {
    sequence += 1;
    clock += 1000;
    const payload = {
      contractVersion: 1, commandId: randomUUID(), identity: c.identity,
      session: staff.payload.session, staffSignInId: staff.payload.staffSignInId,
      sequence, previousCommandHash: previous, occurredAt: clock,
      grantId: c.grant.grantId, grantVersion: c.grant.grantVersion, nominationVersion: c.grant.nominationVersion,
      offlineSessionId, offlineStartedAt, businessHoursAcknowledgementId: null,
      ...body, ...overrides,
    } as unknown as T;
    previous = sha256(commandText(payload));
    return c.device.sign(payload, c.identity.keyId);
  }
  const line = (batchId: string, quantity: number) => {
    const known = c.snapshot.lines.find((l) => l.batchId === batchId)!;
    const net = quantity * known.unitPriceMinor;
    const tax = Number((BigInt(net) * BigInt(known.taxBasisPoints) + 5000n) / 10000n);
    return { line: { snapshotLineId: known.snapshotLineId, quantity, unitPriceMinor: known.unitPriceMinor, discountMinor: 0, taxMinor: tax }, total: net + tax };
  };
  return {
    signIn,
    till,
    offlineStartedAt,
    get sequence() { return sequence; },
    open: (staff: Signed<OfflineStaffSignIn>, openingCashMinor: number, previousClosedWorkSessionId: string | null = null) =>
      entry<OfflineShiftOpenCommand>(staff, { kind: "shift_open", currency: "LKR", openingCashMinor, previousClosedWorkSessionId }),
    sale(staff: Signed<OfflineStaffSignIn>, items: Array<[string, number]>, overrides: Partial<OfflineSaleCommand> = {}) {
      const priced = items.map(([batchId, qty]) => line(batchId, qty));
      const totalMinor = priced.reduce((sum, p) => sum + p.total, 0);
      const payments: OfflinePayment[] = [{ method: "cash", amountMinor: totalMinor, tenderedMinor: totalMinor + 500, changeMinor: 500 }];
      return entry<OfflineSaleCommand>(staff, {
        kind: "ordinary_sale", snapshotId: c.snapshot.snapshotId, snapshotVersion: c.snapshot.snapshotVersion,
        currency: "LKR", lines: priced.map((p) => p.line), payments, totalMinor,
      }, overrides);
    },
    close: (staff: Signed<OfflineStaffSignIn>, closingCashCountMinor: number, expectedCashMinor: number,
      assistance: OfflineShiftCloseCommand["assistance"] = null, cashier?: Signed<OfflineStaffSignIn>) =>
      entry<OfflineShiftCloseCommand>(staff, {
        kind: "shift_close", currency: "LKR", closingCashCountMinor, expectedCashMinor, assistance,
      }, cashier ? { session: cashier.payload.session } : {}),
    /** Re-sign changed content under an existing entry's identity: a modified upload. */
    tamper<T extends OfflineJournalCommand>(original: Signed<T>, change: Partial<T>): Signed<T> {
      return c.device.sign({ ...original.payload, ...change }, c.identity.keyId);
    },
  };
}

const request = (c: Counter, parts: Partial<Omit<SyncRequest, "contractVersion" | "identity">>): SyncRequest => ({
  contractVersion: 1, identity: c.identity, staffSignIns: [], commands: [], supportRecords: [], ...parts,
});
const sync = (c: Counter, parts: Partial<Omit<SyncRequest, "contractVersion" | "identity">>, now?: number) =>
  journal.sync(c.cashier, c.fx.mainBranchId, request(c, parts), now);

function saleAck(ack: SyncAcknowledgement) {
  if (!("commandKind" in ack) || ack.commandKind !== "ordinary_sale") throw new Error(`not a sale ack: ${JSON.stringify(ack)}`);
  return ack;
}
const onHand = async (batchId: string) => (await prisma.batchStock.findUniqueOrThrow({ where: { batchId } })).onHandQty;

afterAll(async () => {
  await prisma.$disconnect();
});

describe("offline journal intake (P5 #51)", () => {
  it("replays shift open, sales and close once, and an identical retry returns the original receipts", async () => {
    const c = await counter({ main: 40 });
    const j = offlineJournal(c);
    const workSessionId = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, workSessionId);
    const open = j.open(cashierIn, 500_000);
    const saleA = j.sale(cashierIn, [[c.batches.main, 2]]);
    const saleB = j.sale(cashierIn, [[c.batches.main, 3]]);
    const cashTaken = saleA.payload.totalMinor + saleB.payload.totalMinor;
    const close = j.close(cashierIn, 500_000 + cashTaken - 100, 500_000 + cashTaken);
    const commands = [open, saleA, saleB, close];

    const response = await sync(c, { staffSignIns: [cashierIn], commands });

    // Signed by the server's key with purpose sync_response, for this exact counter.
    expect(response.keyId).toBe(signer.keyId);
    expect(verify(null, Buffer.from(terminalSigningText("sync_response", response.payload)), server.publicKey,
      Buffer.from(response.signature, "base64url"))).toBe(true);
    expect(response.payload.identity).toEqual(c.identity);
    const acks = response.payload.acknowledgements;
    expect(acks.map((a) => a.status)).toEqual(["committed", "committed", "committed", "committed"]);
    expect(response.payload.committedThroughSequence).toBe(4);
    expect(response.payload.committedThroughHash).toBe(sha256(commandText(close.payload)));
    expect(acks[0]).toMatchObject({ commandKind: "shift_open", workSessionId });
    expect(acks[3]).toMatchObject({ commandKind: "shift_close", workSessionId });

    const shift = await prisma.tillShift.findUniqueOrThrow({ where: { id: workSessionId } });
    expect(shift).toMatchObject({
      staffUserId: c.cashier.userId, openedStaffSessionId: null, openCommandId: open.payload.commandId,
      openedSignInId: cashierIn.payload.staffSignInId, openingCashMinor: 500_000, closeKind: "self",
      closedByUserId: c.cashier.userId, closeCommandId: close.payload.commandId,
      closingCashCountMinor: 500_000 + cashTaken - 100,
      // The server's own figure from the replayed sales (tendered less change), the counter's beside it.
      expectedCashMinor: 500_000 + cashTaken, counterExpectedCashMinor: 500_000 + cashTaken, varianceMinor: -100,
    });
    expect(shift.openedAt.getTime()).toBe(open.payload.occurredAt);
    expect(shift.closedAt!.getTime()).toBe(close.payload.occurredAt);

    const saleRows = await prisma.sale.findMany({
      where: { tenantId: c.fx.tenantId, offlineCommandId: { not: null } },
      include: { items: true, payments: true }, orderBy: { soldAt: "asc" },
    });
    expect(saleRows).toHaveLength(2);
    for (const [row, signed] of [[saleRows[0]!, saleA], [saleRows[1]!, saleB]] as const) {
      expect(row).toMatchObject({
        shiftId: workSessionId, soldBy: c.cashier.userId, terminalId: c.identity.terminalId,
        offlineCommandId: signed.payload.commandId, stockPosting: "posted", workSessionId: cashierIn.payload.staffSignInId,
      });
      expect(row.soldAt.getTime()).toBe(signed.payload.occurredAt);
      expect(row.grandTotal.mul(100).toNumber()).toBe(signed.payload.totalMinor);
      // Saved snapshot prices and tax (D6), not today's catalog.
      expect(row.items[0]!.unitPrice.toFixed(2)).toBe("15.50");
      expect(row.items[0]!.taxAmount.mul(100).toNumber()).toBe(signed.payload.lines[0]!.taxMinor);
      expect(row.payments.map((p) => [p.method, p.shiftId])).toEqual([["cash", workSessionId]]);
    }
    expect(await onHand(c.batches.main)).toBe(35);
    const receipts = await prisma.terminalCommandReceipt.findMany({
      where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId }, orderBy: { offlineSequence: "asc" },
    });
    expect(receipts.map((r) => Number(r.offlineSequence))).toEqual([1, 2, 3, 4]);

    // The response was lost: the counter sends the same bytes again.
    const retry = await sync(c, { staffSignIns: [cashierIn], commands });
    expect(retry.payload.acknowledgements.map((a) => a.status)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);
    expect(saleAck(retry.payload.acknowledgements[1]!).saleId).toBe(saleAck(acks[1]!).saleId);
    expect(retry.payload.acknowledgements[1]!).toMatchObject({ committedAt: (acks[1] as { committedAt: number }).committedAt });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(2);
    expect(await onHand(c.batches.main)).toBe(35);
    expect(await prisma.tillShift.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(retry.payload.committedThroughSequence).toBe(4);

    // A lost acknowledgement never reopens the closed shift: a second close of it is refused.
    const again = j.close(cashierIn, 1, 1);
    const reclosed = await sync(c, { commands: [again] });
    expect(reclosed.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "SESSION_INVALID" } });
    expect((await prisma.tillShift.findUniqueOrThrow({ where: { id: workSessionId } })).closingCashCountMinor).toBe(500_000 + cashTaken - 100);
  });

  it("an assisted close names the manager who closed it, and the next shift follows it", async () => {
    const c = await counter({ main: 10 });
    const j = offlineJournal(c);
    const first = randomUUID();
    const cashierIn = j.signIn(c.cashier.userId, first);
    const managerIn = j.signIn(c.manager.userId, randomUUID());
    const open = j.open(cashierIn, 1_000);
    const sale = j.sale(cashierIn, [[c.batches.main, 1]]);
    const close = j.close(managerIn, 1_000 + sale.payload.totalMinor, 1_000 + sale.payload.totalMinor,
      { managerSignInId: managerIn.payload.staffSignInId, reason: "Cashier left sick" }, cashierIn);
    const second = randomUUID();
    const managerShiftIn = j.signIn(c.manager.userId, second);
    const reopen = j.open(managerShiftIn, 2_000, first);

    const response = await sync(c, { staffSignIns: [cashierIn, managerIn, managerShiftIn], commands: [open, sale, close, reopen] });
    expect(response.payload.acknowledgements.map((a) => a.status)).toEqual(["committed", "committed", "committed", "committed"]);
    expect(await prisma.tillShift.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      staffUserId: c.cashier.userId, closedByUserId: c.manager.userId, closeKind: "assisted",
      assistanceReason: "Cashier left sick", closedSignInId: managerIn.payload.staffSignInId, varianceMinor: 0,
    });
    expect(await prisma.tillShift.findUniqueOrThrow({ where: { id: second } })).toMatchObject({
      staffUserId: c.manager.userId, previousClosedWorkSessionId: first, closedAt: null, openingCashMinor: 2_000,
    });
  });

  it("accepts a reordered upload in sequence order, holds a gap, and keeps later entries queued", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const one = j.open(cashierIn, 0);
    const two = j.sale(cashierIn, [[c.batches.main, 1]]);
    const three = j.sale(cashierIn, [[c.batches.main, 1]]);
    const four = j.sale(cashierIn, [[c.batches.main, 1]]);

    // 3 and 1 arrive, out of order and without 2.
    const first = await sync(c, { staffSignIns: [cashierIn], commands: [three, one] });
    expect(first.payload.acknowledgements).toEqual([
      expect.objectContaining({ sequence: 1, status: "committed" }),
      expect.objectContaining({ sequence: 3, status: "held", error: expect.objectContaining({ code: "SEQUENCE_GAP", retryable: false }) }),
    ]);
    expect(first.payload.committedThroughSequence).toBe(1);
    expect(await prisma.offlineJournalReview.findFirst({ where: { tenantId: c.fx.tenantId, recordId: three.payload.commandId } }))
      .toMatchObject({ outcome: "held", errorCode: "SEQUENCE_GAP", sequence: 3n });

    // 4, 2, 3: all accepted in order; the gap closes.
    const second = await sync(c, { commands: [four, two, three] });
    expect(second.payload.acknowledgements.map((a) => [a.sequence, a.status])).toEqual([[2, "committed"], [3, "committed"], [4, "committed"]]);
    expect(second.payload.committedThroughSequence).toBe(4);
    expect(await onHand(c.batches.main)).toBe(17);
  });

  it("refuses a modified upload or a broken hash chain as REPLAY_CONFLICT and keeps it for review", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.main, 2]]);
    const accepted = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    const original = saleAck(accepted.payload.acknowledgements[1]!);

    // Same command ID, other content.
    const changed = j.tamper(sale, { lines: [{ ...sale.payload.lines[0]!, quantity: 1 }] });
    const conflict = await sync(c, { commands: [changed] });
    expect(conflict.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    // Same sequence, another command ID.
    const sameSequence = j.tamper(sale, { commandId: randomUUID() });
    const conflict2 = await sync(c, { commands: [sameSequence] });
    expect(conflict2.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    const kept = await prisma.offlineJournalReview.findMany({ where: { tenantId: c.fx.tenantId, outcome: "conflict" } });
    expect(kept.map((r) => r.originalRecordHash)).toEqual([accepted.payload.committedThroughHash, accepted.payload.committedThroughHash]);
    // Resending the same changed bytes is still the same retained upload, counted again.
    await sync(c, { commands: [changed] });
    expect((await prisma.offlineJournalReview.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, recordHash: sha256(commandText(changed.payload)) } })).attempts).toBe(2);
    await expect(prisma.offlineJournalReview.deleteMany({ where: { tenantId: c.fx.tenantId } })).rejects.toThrow(/retained/);

    // A next entry that does not name the accepted head.
    const forked = j.sale(cashierIn, [[c.batches.main, 1]], { previousCommandHash: randomBytes(32).toString("hex") });
    const broken = await sync(c, { commands: [forked] });
    expect(broken.payload.acknowledgements[0]).toMatchObject({ sequence: 3, status: "rejected", error: { code: "REPLAY_CONFLICT" } });
    expect(broken.payload.committedThroughSequence).toBe(2);

    // The original stands, once.
    const replay = await sync(c, { commands: [sale] });
    expect(saleAck(replay.payload.acknowledgements[0]!)).toMatchObject({ status: "duplicate", saleId: original.saleId });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(await onHand(c.batches.main)).toBe(18);
  });

  it("gives concurrent identical retries one sale and the same receipt", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 4]])];
    const results = await Promise.all([1, 2, 3, 4].map(() => sync(c, { staffSignIns: [cashierIn], commands })));
    const saleAcks = results.map((r) => saleAck(r.payload.acknowledgements[1]!));
    expect(new Set(saleAcks.map((a) => a.saleId)).size).toBe(1);
    expect(saleAcks.filter((a) => a.status === "committed")).toHaveLength(1);
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(await onHand(c.batches.main)).toBe(16);
    expect(await prisma.offlineStaffSignIn.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
  });

  it("partition: snapshot 10, 7 sold online, 5 offline — keeps the sale, opens a 2-unit case and blocks only that batch", async () => {
    const c = await counter({ partition: 10, other: 20 });
    expect(c.snapshot.lines.find((l) => l.batchId === c.batches.partition)!.availableQuantity).toBe(10);

    // While the offline counter is cut off, another counter sells 7 online.
    await sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
      { items: [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 7, unitPrice: "15.50" }] } as never, undefined);
    expect(await onHand(c.batches.partition)).toBe(3);

    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.partition, 5]]);
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    const ack = saleAck(response.payload.acknowledgements[1]!);
    expect(ack).toMatchObject({ status: "committed", stockPosting: "pending_reconciliation" });
    // The accepted sale advances the watermark although its stock is pending.
    expect(response.payload.committedThroughSequence).toBe(2);

    const saleRow = await prisma.sale.findUniqueOrThrow({ where: { id: ack.saleId }, include: { payments: true } });
    expect(saleRow).toMatchObject({ stockPosting: "pending_reconciliation", offlineCommandId: sale.payload.commandId });
    expect(saleRow.payments).toHaveLength(1);
    // Nothing posted, nothing clamped, nothing invented: the 3 left on the shelf are untouched.
    expect(await onHand(c.batches.partition)).toBe(3);
    expect(await prisma.stockLedger.count({ where: { tenantId: c.fx.tenantId, referenceId: ack.saleId } })).toBe(0);
    const discrepancy = await prisma.offlineStockDiscrepancy.findUniqueOrThrow({
      where: { id: ack.reconciliationCaseId! }, include: { lines: true, blocks: true },
    });
    expect(discrepancy).toMatchObject({ status: "open", saleId: ack.saleId, commandId: sale.payload.commandId,
      snapshotId: c.snapshot.snapshotId, snapshotVersion: c.snapshot.snapshotVersion });
    expect(discrepancy.lines).toEqual([expect.objectContaining({
      batchId: c.batches.partition, soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2, reason: "shortfall",
    })]);
    expect(discrepancy.blocks.map((b) => [b.batchId, b.releasedAt])).toEqual([[c.batches.partition, null]]);

    // Central checkout refuses the blocked batch, by name or by FEFO, and sells the other one.
    await expect(sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
      { items: [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 1, unitPrice: "15.50" }] } as never, undefined))
      .rejects.toMatchObject({ response: { code: "BATCH_STOCK_REVIEW" } });
    const fefo = await sales.checkout(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId, [],
      { items: [{ productId: c.fx.productId, qty: 2, unitPrice: "15.50" }] } as never, undefined);
    expect(fefo!.items.map((i) => i.batchId)).toEqual([c.batches.other]);
    expect(await onHand(c.batches.other)).toBe(18);
    // The pending sale can't be voided: that would put back stock it never took.
    await expect(sales.voidSale(c.fx.tenantId, c.fx.mainBranchId, c.owner.userId,
      [{ branchId: c.fx.mainBranchId, role: RoleName.owner }], ack.saleId, "test"))
      .rejects.toMatchObject({ response: { code: "STOCK_POSTING_PENDING" } });

    // A fresh snapshot for any counter at this branch marks the blocked batch for review.
    const state = await prisma.$transaction((tx) => emptyJournalState(tx, { ...c.identity, enrollmentId: randomUUID() }));
    expect([...state.reviewRequiredBatchIds]).toEqual([c.batches.partition]);

    // The response was lost: the retry returns the original receipt, case included.
    const retry = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    expect(saleAck(retry.payload.acknowledgements[1]!)).toEqual({ ...ack, status: "duplicate" });
    expect(await prisma.offlineStockDiscrepancy.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);

    // A later offline sale from the blocked batch waits too, even though 3 are on the shelf:
    // that batch's count is under review, so nothing more is posted into it.
    const another = j.sale(cashierIn, [[c.batches.partition, 1]]);
    const second = saleAck((await sync(c, { commands: [another] })).payload.acknowledgements[0]!);
    expect(second).toMatchObject({ status: "committed", stockPosting: "pending_reconciliation" });
    expect(await prisma.offlineStockDiscrepancyLine.findFirstOrThrow({ where: { caseId: second.reconciliationCaseId! } }))
      .toMatchObject({ soldQuantity: 1, availableQuantityAtSync: 3, shortfallQuantity: 0, reason: "batch_under_review" });
    expect(await onHand(c.batches.partition)).toBe(3);
  });

  it("acknowledges support records in the same upload, and refuses a counter login from another counter", async () => {
    const c = await counter({ main: 5 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const incident = c.device.sign({
      contractVersion: 1, kind: "sale_incident", recordId: randomUUID(), identity: c.identity,
      saleCommandId: randomUUID(), recordedByUserId: c.cashier.userId, staffSignInId: cashierIn.payload.staffSignInId,
      workSessionId: cashierIn.payload.session.workSessionId, recordedAt: j.offlineStartedAt, category: "other",
      description: "Customer queried the change",
    }, c.identity.keyId);
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open], supportRecords: [incident as never] });
    expect(response.payload.supportAcknowledgements).toEqual([
      expect.objectContaining({ recordId: incident.payload.recordId, status: "held", error: expect.objectContaining({ code: "RECONCILIATION_REQUIRED" }) }),
    ]);
    expect(response.payload.acknowledgements.map((a) => a.status)).toEqual(["committed"]);

    // A PIN-opened login bound to some other counter's staff session cannot upload this journal.
    const elsewhere = await prisma.terminalStaffSession.findFirstOrThrow({ where: { tenantId: c.fx.tenantId } });
    await prisma.terminalStaffSession.update({ where: { id: elsewhere.id }, data: { closedAt: new Date() } });
    const other = await prisma.terminalStaffSession.create({
      data: { ...elsewhere, id: randomUUID(), enrollmentId: elsewhere.enrollmentId, closedAt: null, openedAt: new Date() },
    });
    await expect(journal.sync({ ...c.cashier, counter: { workSessionId: other.id, branchId: c.fx.mainBranchId } },
      c.fx.mainBranchId, request(c, { commands: [open] }))).resolves.toBeDefined();
    await expect(journal.sync({ ...c.cashier, counter: { workSessionId: randomUUID(), branchId: c.fx.mainBranchId } },
      c.fx.mainBranchId, request(c, { commands: [open] }))).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
  });

  it("keeps a whole sale pending when one of its batches falls short, and blocks each of its batches", async () => {
    const c = await counter({ short: 4, fine: 10 });
    await prisma.$transaction((t) => stock.issue(
      t, { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId, userId: c.fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: c.fx.productId, batchId: c.batches.short, qty: 3, movementType: StockMovementType.adjustment_out }],
    ));
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const response = await sync(c, {
      staffSignIns: [cashierIn],
      commands: [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.short, 2], [c.batches.fine, 1]])],
    });
    const ack = saleAck(response.payload.acknowledgements[1]!);
    expect(ack.stockPosting).toBe("pending_reconciliation");
    expect(await onHand(c.batches.fine)).toBe(10);
    const lines = await prisma.offlineStockDiscrepancyLine.findMany({ where: { caseId: ack.reconciliationCaseId! }, orderBy: { reason: "asc" } });
    expect(lines.map((l) => [l.batchId, l.reason, l.shortfallQuantity])).toEqual(
      [[c.batches.fine, "sale_pending", 0], [c.batches.short, "shortfall", 1]].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
    expect(await prisma.batchSaleBlock.count({ where: { caseId: ack.reconciliationCaseId!, releasedAt: null } })).toBe(2);
  });

  it("recovers a journal after the grant expired, but refuses a sale made after expiry", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const commands = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 1]])];
    const afterExpiry = c.grant.expiresAt + 60 * 60 * 1000;
    // Late arrival alone is no reason to refuse: these happened while the grant was valid.
    const late = await sync(c, { staffSignIns: [cashierIn], commands }, afterExpiry);
    expect(late.payload.acknowledgements.map((a) => a.status)).toEqual(["committed", "committed"]);
    const replay = await sync(c, { commands }, afterExpiry + 1);
    expect(replay.payload.acknowledgements.map((a) => a.status)).toEqual(["duplicate", "duplicate"]);
    const tooLate = j.sale(cashierIn, [[c.batches.main, 1]], { occurredAt: c.grant.expiresAt });
    const refused = await sync(c, { commands: [tooLate] }, afterExpiry);
    expect(refused.payload.acknowledgements[0]).toMatchObject({ status: "rejected", error: { code: "GRANT_EXPIRED" } });
    expect(await onHand(c.batches.main)).toBe(19);
  });

  it("from a revoked counter, replays what was accepted and holds anything new for review", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const accepted = [j.open(cashierIn, 0), j.sale(cashierIn, [[c.batches.main, 1]])];
    await sync(c, { staffSignIns: [cashierIn], commands: accepted });
    await prisma.$transaction((tx) => trust.revokeEnrollment(tx, c.owner, c.fx.mainBranchId, c.identity.enrollmentId, "Stolen"));

    const later = j.sale(cashierIn, [[c.batches.main, 1]]);
    // An owner recovers the journal with an ordinary login: the counter can no longer sign in.
    const response = await journal.sync(c.owner, c.fx.mainBranchId, request(c, { commands: [...accepted, later] }));
    expect(response.payload.acknowledgements.map((a) => a.status)).toEqual(["duplicate", "duplicate", "held"]);
    expect(response.payload.acknowledgements[2]).toMatchObject({ error: { code: "TERMINAL_REVOKED" } });
    expect(await prisma.sale.count({ where: { tenantId: c.fx.tenantId } })).toBe(1);
    expect(await prisma.offlineJournalReview.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, recordId: later.payload.commandId } }))
      .toMatchObject({ outcome: "held", errorCode: "TERMINAL_REVOKED" });
  });

  it("refuses the whole upload when anything is not signed by the enrollment's key, and keeps nothing", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const forged = { ...open, signature: terminalDevice().sign(open.payload, c.identity.keyId).signature };
    await expect(sync(c, { staffSignIns: [cashierIn], commands: [forged] })).rejects.toMatchObject({ response: { code: "INVALID_SIGNATURE" } });
    await expect(sync(c, { commands: [{ ...open, payload: { ...open.payload, extra: 1 } } as never] }))
      .rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
    expect(await prisma.offlineStaffSignIn.count({ where: { tenantId: c.fx.tenantId } })).toBe(0);
    expect(await prisma.terminalCommandReceipt.count({ where: { tenantId: c.fx.tenantId } })).toBe(0);
  });

  it("validates each sale against the signed snapshot: no repricing, no unknown sign-in", async () => {
    const c = await counter({ main: 20 });
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    await sync(c, { staffSignIns: [cashierIn], commands: [j.open(cashierIn, 0)] });
    // Today's catalog price changed; the offline sale still carries the snapshot's price.
    await prisma.batch.update({ where: { id: c.batches.main }, data: { sellingPrice: "99.00" } });
    const good = j.sale(cashierIn, [[c.batches.main, 1]]);
    expect(saleAck((await sync(c, { commands: [good] })).payload.acknowledgements[0]!).status).toBe("committed");
    const sold = await prisma.saleItem.findFirstOrThrow({ where: { tenantId: c.fx.tenantId } });
    expect(sold.unitPrice.toFixed(2)).toBe("15.50");

    const repriced = j.sale(cashierIn, [[c.batches.main, 1]]);
    const cheaper = j.tamper(repriced, { lines: [{ ...repriced.payload.lines[0]!, unitPriceMinor: 1 }] });
    expect((await sync(c, { commands: [cheaper] })).payload.acknowledgements[0])
      .toMatchObject({ status: "rejected", error: { code: "INVALID_COMMAND" } });

    const stranger = j.signIn(c.cashier.userId, cashierIn.payload.session.workSessionId);
    // Not uploaded: the sale waits for its sign-in rather than being refused for good.
    const waiting = j.tamper(repriced, { staffSignInId: stranger.payload.staffSignInId });
    expect((await sync(c, { commands: [waiting] })).payload.acknowledgements[0])
      .toMatchObject({ status: "held", error: { code: "SESSION_INVALID" } });
    expect((await sync(c, { staffSignIns: [stranger], commands: [waiting] })).payload.acknowledgements[0])
      .toMatchObject({ status: "committed" });
  });
});
