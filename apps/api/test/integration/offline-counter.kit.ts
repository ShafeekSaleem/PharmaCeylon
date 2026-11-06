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

/**
 * P5 #51 test kit: an enrolled, nominated offline counter with prepared staff, stock and issued
 * authority, and a durable offline journal to sync — shared by the journal intake and the stock
 * case resolution suites. Module singletons: each test file gets its own instance.
 */
export const prisma = createPrisma();
export const audit = new AuditService(prisma as never);
export const access = new AccessService(prisma as never, {} as never);
export const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
export const proofs = new AttendanceProofsService(prisma as never, access);
export const assignments = new OfflineAssignmentService(prisma as never, access, audit);
export const activation = new OfflineActivationService(prisma as never, trust, assignments, new OfflineActivationClearance(), audit);
export const stock = new StockService();
export const shifts = new TillShiftsService(prisma as never, trust, new OperatingHoursEvidence(), access, audit, {} as never);
export const sales = new SalesService(
  prisma as never, audit, new TaxService({ get: () => "18" } as never), {} as never,
  { assertCanSell: async () => undefined } as never, stock,
);

export const server = generateKeyPairSync("ed25519");
export const signer = { keyId: "offline-journal-it", privateKey: server.privateKey };
export const config = {
  get: (key: string) =>
    key === "OFFLINE_AUTHORITY_KEY_ID" ? signer.keyId
      : key === "OFFLINE_AUTHORITY_PRIVATE_KEY" ? (server.privateKey.export({ format: "pem", type: "pkcs8" }) as string)
        : undefined,
};
export const journal = new OfflineJournalService(
  prisma as never, access, audit, stock,
  new OfflineSupportRecords(access, audit, new BusinessHoursAcknowledgements(access, audit)),
  shifts, config as never,
);

export type Device = ReturnType<typeof terminalDevice>;

/** One branch with its own nominated offline counter, prepared staff, stock and issued authority. */
export type Counter = {
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

export function user(fx: TenantFixture, userId: string): RequestUser {
  return { userId, tenantId: fx.tenantId, tokenVersion: 0, email: "t@example.test", fullName: "T", authMethod: "bearer", branchRoles: [] };
}

export function attest(
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

export async function stockedBatch(fx: TenantFixture, qty: number) {
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

export async function counter(stockByBatch: Record<string, number> = { main: 40 }): Promise<Counter> {
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
export function offlineJournal(c: Counter) {
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

export const request = (c: Counter, parts: Partial<Omit<SyncRequest, "contractVersion" | "identity">>): SyncRequest => ({
  contractVersion: 1, identity: c.identity, staffSignIns: [], commands: [], supportRecords: [], ...parts,
});
export const sync = (c: Counter, parts: Partial<Omit<SyncRequest, "contractVersion" | "identity">>, now?: number) =>
  journal.sync(c.cashier, c.fx.mainBranchId, request(c, parts), now);

export function saleAck(ack: SyncAcknowledgement) {
  if (!("commandKind" in ack) || ack.commandKind !== "ordinary_sale") throw new Error(`not a sale ack: ${JSON.stringify(ack)}`);
  return ack;
}
export const onHand = async (batchId: string) => (await prisma.batchStock.findUniqueOrThrow({ where: { batchId } })).onHandQty;
