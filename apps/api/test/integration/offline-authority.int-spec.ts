import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Prisma, RoleName, StockMovementType } from "@prisma/client";
import {
  defaultCounterPolicy,
  MAX_OFFLINE_GRANT_MS,
  type BranchHours,
  type LocalAttendanceAttestation,
  type OnlineTerminalCommand,
  type TerminalEnrollmentCommand,
  type TerminalIdentity,
  type TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import {
  OfflineActivationClearance,
  OfflineActivationService,
} from "../../src/terminals/offline-activation.service";
import { OfflineAssignmentService } from "../../src/terminals/offline-assignment.service";
import { acceptedJournalState, issueOfflineAuthority } from "../../src/terminals/offline-authority-issuance";
import { verifyStockSnapshot } from "../../src/terminals/stock-snapshot";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

/** P3 #49: initial offline authority from a real nominated counter, against PostgreSQL. */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
const proofs = new AttendanceProofsService(prisma as never, access);
const assignments = new OfflineAssignmentService(prisma as never, access, audit);
const activation = new OfflineActivationService(
  prisma as never, trust, assignments, new OfflineActivationClearance(), audit,
);
const stock = new StockService();
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });

const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority-it", privateKey: server.privateKey };
type Device = ReturnType<typeof terminalDevice>;

let fx: TenantFixture;
let owner: RequestUser;
let manager: RequestUser;
let cashier: RequestUser;

function user(userId: string): RequestUser {
  return {
    userId, tenantId: fx.tenantId, tokenVersion: 0, email: "t@example.test",
    fullName: "T", authMethod: "bearer", branchRoles: [],
  };
}

function attest(
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

const proof = (device: Device, a: LocalAttendanceAttestation, actor: RequestUser) =>
  proofs.record(actor, fx.mainBranchId, device.sign(a, a.identity.keyId, "attendance"));

async function enroll() {
  const device = terminalDevice();
  const counter = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, `Counter ${randomUUID().slice(0, 4)}`));
  const challenge = await tx((c) => trust.beginEnrollment(c, owner, fx.mainBranchId, {
    registerId: counter.id, keyId: randomUUID(), publicKeyHex: device.publicKeyHex, label: "PC",
  }));
  const p = await proof(device, attest(challenge, "enrollment", owner), owner);
  const identity = await tx((c) => trust.finishEnrollment(
    c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), p.proofId,
  ));
  return { device, identity };
}

/** Enrolls a counter and makes it the branch's offline counter through revised D13. */
async function nominatedCounter() {
  const { device, identity } = await enroll();
  const challenge = await tx((c) => trust.beginSession(c, manager, fx.mainBranchId, identity));
  const p = await proof(device, attest(challenge, "session", manager), manager);
  const { workSessionId } = await tx((c) => trust.finishSession(
    c, manager, fx.mainBranchId, device.sign(challenge, identity.keyId), p.proofId,
  ));
  const authorizationId = randomUUID();
  await assignments.authorize(owner, fx.mainBranchId, {
    authorizationId, targetTerminalId: identity.terminalId, targetEnrollmentId: identity.enrollmentId,
    expectedNominationVersion: 0, reason: "Front counter keeps selling during outages",
  });
  const command = await activation.prepare(manager, fx.mainBranchId, {
    workSessionId, authorizationId, expectedNominationVersion: 0,
  });
  const ap = await proof(device, attest(command, "command", manager), manager);
  await activation.activate(manager, fx.mainBranchId, {
    envelope: device.sign(command, identity.keyId), attendanceProofId: ap.proofId,
  });
  return identity;
}

/** Prepares the cashier's personal PIN on this counter, as signing in there once online does. */
async function prepare(identity: TerminalIdentity, staffUserId: string) {
  await prisma.appUser.update({
    where: { id: staffUserId },
    data: { posPinHash: "prepared-in-test", posPinVersion: 1 },
  });
  await prisma.terminalStaffPreparation.create({
    data: {
      tenantId: identity.tenantId, branchId: identity.branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, staffUserId, pinVersion: 1,
    },
  });
}

async function product(name: string, flags: Partial<{ isControlled: boolean; requiresPrescription: boolean }> = {}) {
  const row = await prisma.product.create({
    data: { tenantId: fx.tenantId, sku: `IT-${randomUUID().slice(0, 8)}`, name, rangeStatus: "RANGED", ...flags },
  });
  return row.id;
}

async function batch(productId: string, qty: number, expiryInDays = 365) {
  const row = await prisma.batch.create({
    data: {
      tenantId: fx.tenantId, branchId: fx.mainBranchId, productId, batchNo: `B-${randomUUID().slice(0, 6)}`,
      expiryDate: daysFromToday(expiryInDays), costPrice: "10.00", sellingPrice: "15.50", supplierId: fx.supplierId,
    },
  });
  await prisma.$transaction((t) => stock.receive(
    t,
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
    [{ productId, batchId: row.id, qty, movementType: StockMovementType.opening_stock }],
  ));
  return row.id;
}

const issue = (identity: TerminalIdentity, commandId: string) =>
  issueOfflineAuthority(prisma as never, access, {
    signer,
    defaultVatRatePercent: 18,
    // The signed command and its attendance are proven in terminal-execution; this file covers
    // what issuance does once the device and actor are authenticated.
    authenticate: async () => ({ identity, commandId }),
    readState: acceptedJournalState,
  });

const hours = (opens: string, closes: string) => ({ mode: "hours" as const, ranges: [{ opens, closes }] });
const allWeek = (day: BranchHours["weekly"]["mon"]) =>
  ({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day });

let eligible: string;
let quarantined: string;
let controlled: string;
let prescription: string;
let expired: string;

beforeAll(async () => {
  fx = await createTenant(prisma, "offline-authority");
  owner = user(fx.ownerId);
  manager = user(fx.managerId);
  cashier = user(fx.clerkId);
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: RoleName.manager },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
    ],
  });
  await prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: {
      counterPolicy: { ...defaultCounterPolicy(), offlineEnabled: true } as unknown as Prisma.InputJsonValue,
      operatingHours: { schemaVersion: 1, weekly: allWeek(hours("08:00", "22:00")), exceptions: [], mandatory: null } as unknown as Prisma.InputJsonValue,
      operatingHoursOrigin: "editor",
    },
  });
  eligible = await batch(fx.productId, 40);
  quarantined = await batch(fx.productId, 10);
  await prisma.$transaction((t) => stock.quarantine(
    t,
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, referenceId: randomUUID() },
    { productId: fx.productId, batchId: quarantined, qty: 4, reasonCode: "damaged", reason: "Crushed box" },
  ));
  controlled = await batch(await product("Morphine", { isControlled: true }), 5);
  prescription = await batch(await product("Amoxicillin", { requiresPrescription: true }), 5);
  expired = await batch(fx.productId, 5, -1);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("initial offline authority (P3 #49)", () => {
  let identity: TerminalIdentity;

  it("issues a signed 24-hour grant and a last-known snapshot, and reserves nothing", async () => {
    identity = await nominatedCounter();
    await prepare(identity, cashier.userId);
    const reservationsBefore = await prisma.stockReservation.count({ where: { tenantId: fx.tenantId } });
    const totalsBefore = await prisma.batchStock.findMany({ where: { tenantId: fx.tenantId }, orderBy: { batchId: "asc" } });

    const { grant, snapshot } = await issue(identity, randomUUID());

    // Signed for this exact device, and verifiable with the server's public key only.
    expect(verifyStockSnapshot(snapshot, identity, { keyId: signer.keyId, publicKey: server.publicKey })).toBe(true);
    expect(snapshot.payload.identity).toEqual(identity);
    expect(grant.payload).toMatchObject({ identity, grantVersion: snapshot.payload.snapshotVersion, externalCardAllowed: false });
    expect(grant.payload.expiresAt - grant.payload.issuedAt).toBe(MAX_OFFLINE_GRANT_MS);
    expect(grant.payload.authorizedStaff).toEqual([
      expect.objectContaining({ staffUserId: cashier.userId, credentialVersion: 1, signInMethod: "personal_pin" }),
    ]);
    expect(grant.payload.operatingWindows.length).toBeGreaterThan(0);
    expect(grant.payload.mandatoryOperatingWindows).toBeNull();

    // Available units only; controlled, prescription and expired stock never become offline-sellable.
    const lines = new Map(snapshot.payload.lines.map((line) => [line.batchId, line]));
    expect(lines.get(eligible)).toMatchObject({ availableQuantity: 40, unitPriceMinor: 1550, taxBasisPoints: 1800, stockReviewRequired: false });
    expect(lines.get(quarantined)?.availableQuantity).toBe(6);
    for (const batchId of [controlled, prescription, expired]) expect(lines.has(batchId)).toBe(false);
    expect(snapshot.payload).toMatchObject({ includedThroughSequence: 0, includedThroughHash: null });

    // No offline reservation, and normal online availability is untouched.
    expect(await prisma.stockReservation.count({ where: { tenantId: fx.tenantId } })).toBe(reservationsBefore);
    expect(await prisma.batchStock.findMany({ where: { tenantId: fx.tenantId }, orderBy: { batchId: "asc" } })).toEqual(totalsBefore);
  });

  it("replays the original pair after a lost response", async () => {
    const requestId = randomUUID();
    const counter = await nominatedCounterAfterReplacement();
    const first = await issue(counter, requestId);
    const again = await issue(counter, requestId);
    expect(again).toEqual(first);
    expect(await prisma.offlineStockSnapshot.count({ where: { enrollmentId: counter.enrollmentId } })).toBe(1);
  });

  it("renews at watermark 0 while the offline journal is empty, as a new version that keeps the earlier ones", async () => {
    const counter = await nominatedCounterAfterReplacement();
    const firstRequest = randomUUID();
    const first = await issue(counter, firstRequest);
    // Stock moves between issuances: the renewal is a fresh last-known view, the first is kept as it was.
    await prisma.$transaction((t) => stock.issue(
      t,
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, referenceType: "sale", referenceId: randomUUID() },
      [{ productId: fx.productId, batchId: eligible, qty: 3, movementType: StockMovementType.sale_out }],
    ));
    const second = await issue(counter, randomUUID());
    const third = await issue(counter, randomUUID());

    expect([first, second, third].map((pair) => pair.grant.payload.grantVersion)).toEqual([1, 2, 3]);
    for (const pair of [first, second, third]) {
      expect(pair.grant.payload.grantVersion).toBe(pair.snapshot.payload.snapshotVersion);
      expect(pair.snapshot.payload).toMatchObject({ includedThroughSequence: 0, includedThroughHash: null });
      expect(pair.snapshot.payload.lines.every((line) => !line.stockReviewRequired)).toBe(true);
      expect(verifyStockSnapshot(pair.snapshot, counter, { keyId: signer.keyId, publicKey: server.publicKey })).toBe(true);
    }
    const available = (pair: typeof first) => pair.snapshot.payload.lines.find((l) => l.batchId === eligible)?.availableQuantity;
    expect(available(second)).toBe(available(first)! - 3);
    // 24 hours from this renewal, not from the first issuance.
    expect(second.grant.payload.expiresAt - second.grant.payload.issuedAt).toBe(MAX_OFFLINE_GRANT_MS);
    expect(second.grant.payload.issuedAt).toBeGreaterThanOrEqual(first.grant.payload.issuedAt);
    expect(new Set([first, second, third].map((p) => p.grant.payload.grantId)).size).toBe(3);

    // Every version is kept, unchanged, and an old request still replays its own version.
    const kept = await prisma.offlineStockSnapshot.findMany({
      where: { enrollmentId: counter.enrollmentId }, orderBy: { version: "asc" }, select: { version: true, envelope: true },
    });
    expect(kept.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(kept[0].envelope).toEqual(first.snapshot);
    expect(await issue(counter, firstRequest)).toEqual(first);
    expect(await prisma.offlineAuthorityIssuance.count({ where: { enrollmentId: counter.enrollmentId } })).toBe(3);
    // Still nothing reserved for the offline counter.
    expect(await prisma.stockReservation.count({ where: { tenantId: fx.tenantId } })).toBe(0);
  });

  it("rebases a renewal over the accepted journal: the watermark is its head, and a lost response still replays", async () => {
    const counter = await nominatedCounterAfterReplacement();
    const issuedRequest = randomUUID();
    const issued = await issue(counter, issuedRequest);
    await acceptOfflineJournalEntry(counter, 1n);
    const head = await acceptOfflineJournalEntry(counter, 2n);

    const rebased = await issue(counter, randomUUID());
    expect(rebased.snapshot.payload).toMatchObject({ includedThroughSequence: 2, includedThroughHash: head });
    expect(rebased.grant.payload.grantVersion).toBe(2);
    expect(verifyStockSnapshot(rebased.snapshot, counter, { keyId: signer.keyId, publicKey: server.publicKey })).toBe(true);
    // The pair issued before the entries were accepted is still what its request gets back.
    expect(await issue(counter, issuedRequest)).toEqual(issued);
  });

  it("issues even the first pair over an accepted journal, at its head", async () => {
    const counter = await nominatedCounterAfterReplacement();
    const head = await acceptOfflineJournalEntry(counter, 1n);
    await expect(issue(counter, randomUUID())).resolves.toMatchObject({
      snapshot: { payload: { includedThroughSequence: 1, includedThroughHash: head } },
    });
  });

  it("refuses while the journal is stuck past its head on an entry that needs review", async () => {
    const counter = await nominatedCounterAfterReplacement();
    await acceptOfflineJournalEntry(counter, 1n);
    // Held entries are repaired by the counter itself (a gap, a sign-in still to upload), and a
    // conflicting copy of an entry already accepted doesn't stop the chain: neither refuses.
    await retainJournalReview(counter, 3n, "held", "SEQUENCE_GAP");
    await retainJournalReview(counter, 1n, "conflict", "REPLAY_CONFLICT");
    await expect(issue(counter, randomUUID())).resolves.toMatchObject({ snapshot: { payload: { includedThroughSequence: 1 } } });

    await retainJournalReview(counter, 2n, "rejected", "LOCAL_STOCK_EXHAUSTED");
    await expect(issue(counter, randomUUID())).rejects.toMatchObject({ response: { code: "RECONCILIATION_REQUIRED" } });
    expect(await prisma.offlineStockSnapshot.count({ where: { enrollmentId: counter.enrollmentId } })).toBe(1);

    // Once an entry is accepted at that sequence (whatever repaired it), the journal moves on.
    await acceptOfflineJournalEntry(counter, 2n);
    await expect(issue(counter, randomUUID())).resolves.toMatchObject({ snapshot: { payload: { includedThroughSequence: 2 } } });
  });

  it("refuses a fork: an entry past the head that doesn't follow the accepted chain", async () => {
    const counter = await nominatedCounterAfterReplacement();
    await acceptOfflineJournalEntry(counter, 1n);
    await retainJournalReview(counter, 2n, "conflict", "REPLAY_CONFLICT");
    await expect(issue(counter, randomUUID())).rejects.toMatchObject({ response: { code: "RECONCILIATION_REQUIRED" } });
  });

  it("an online command receipt is not offline journal", async () => {
    const counter = await nominatedCounterAfterReplacement();
    await acceptOfflineJournalEntry(counter, null);
    await expect(issue(counter, randomUUID())).resolves.toMatchObject({ grant: { payload: { grantVersion: 1 } } });
  });

  it("gives concurrent renewals their own consecutive versions", async () => {
    const counter = await nominatedCounterAfterReplacement();
    await issue(counter, randomUUID());
    const pairs = await Promise.all([issue(counter, randomUUID()), issue(counter, randomUUID()), issue(counter, randomUUID())]);
    expect(pairs.map((p) => p.grant.payload.grantVersion).sort()).toEqual([2, 3, 4]);
    for (const pair of pairs) expect(pair.snapshot.payload.snapshotVersion).toBe(pair.grant.payload.grantVersion);
    expect(await prisma.offlineAuthorityIssuance.count({ where: { enrollmentId: counter.enrollmentId } })).toBe(4);
  });

  it("never renews or replays to a counter that has been replaced", async () => {
    const old = await nominatedCounterAfterReplacement();
    const request = randomUUID();
    await issue(old, request);
    const replacement = await nominatedCounterAfterReplacement();

    await expect(issue(old, randomUUID())).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(issue(old, request)).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    // The old counter's evidence stays; only the current nomination receives authority.
    expect(await prisma.offlineStockSnapshot.count({ where: { enrollmentId: old.enrollmentId } })).toBe(1);
    await expect(issue(replacement, randomUUID())).resolves.toMatchObject({ grant: { payload: { identity: replacement } } });
  });

  it("a renewal racing a replacement is refused once the replacement commits", async () => {
    const old = await nominatedCounterAfterReplacement();
    await issue(old, randomUUID());
    const { identity: next } = await enroll();
    const current = await prisma.offlineTerminalNomination.findFirstOrThrow({
      where: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
    });
    let renewal: Promise<unknown> | undefined;
    await prisma.$transaction(async (t) => {
      await t.offlineTerminalNomination.update({
        where: { id: current.id },
        data: { terminalId: next.terminalId, enrollmentId: next.enrollmentId, keyId: next.keyId, version: current.version + 1 },
      });
      // The renewal reads the old nomination, then waits on its row until the move commits.
      renewal = issue(old, randomUUID());
      renewal.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }, { timeout: 15_000 });
    await expect(renewal).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    expect(await prisma.offlineStockSnapshot.count({ where: { enrollmentId: old.enrollmentId } })).toBe(1);
  });

  it("gives identical concurrent requests one issuance and the same pair", async () => {
    const counter = await nominatedCounterAfterReplacement();
    const requestId = randomUUID();
    const [a, b] = await Promise.all([issue(counter, requestId), issue(counter, requestId)]);
    expect(a.grant.signature).toBe(b.grant.signature);
    expect(a.snapshot.signature).toBe(b.snapshot.signature);
    expect(await prisma.offlineAuthorityIssuance.count({ where: { enrollmentId: counter.enrollmentId } })).toBe(1);
  });

  it("keeps issued evidence: snapshots and issuances can't be rewritten or deleted", async () => {
    await expect(prisma.offlineStockSnapshot.updateMany({
      where: { enrollmentId: identity.enrollmentId }, data: { version: 99 },
    })).rejects.toThrow(/immutable/);
    await expect(prisma.offlineAuthorityIssuance.deleteMany({
      where: { enrollmentId: identity.enrollmentId },
    })).rejects.toThrow(/immutable/);
  });

  it("refuses a counter that isn't the branch's offline counter, and stores nothing", async () => {
    const { identity: other } = await enroll();
    await expect(issue(other, randomUUID())).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    expect(await prisma.offlineStockSnapshot.count({ where: { enrollmentId: other.enrollmentId } })).toBe(0);
  });

  it("needs the branch's selling hours: unset hours are setup, not a passing fault", async () => {
    const counter = await nominatedCounterAfterReplacement();
    await prisma.branch.update({ where: { id: fx.mainBranchId }, data: { operatingHours: Prisma.DbNull, operatingHoursOrigin: null } });
    try {
      await expect(issue(counter, randomUUID())).rejects.toMatchObject({ response: { code: "BRANCH_HOURS_NOT_CONFIGURED" } });
      expect(await prisma.offlineStockSnapshot.count({ where: { enrollmentId: counter.enrollmentId } })).toBe(0);
    } finally {
      await prisma.branch.update({
        where: { id: fx.mainBranchId },
        data: {
          operatingHours: { schemaVersion: 1, weekly: allWeek(hours("08:00", "22:00")), exceptions: [], mandatory: null } as unknown as Prisma.InputJsonValue,
          operatingHoursOrigin: "editor",
        },
      });
    }
  });

  it("refuses a grant nobody prepared on the counter could use", async () => {
    const counter = await nominatedCounterAfterReplacement({ prepared: false });
    await expect(issue(counter, randomUUID())).rejects.toMatchObject({ response: { code: "GRANT_INVALID" } });
  });
});

/**
 * Each case needs a fresh nominated counter. D11 only clears the first nomination (replacement
 * waits on P3/P5 evidence), so the tests point the branch's nomination row at the new counter
 * directly instead of running a second D13 activation.
 */
async function nominatedCounterAfterReplacement({ prepared = true } = {}) {
  const { identity } = await enroll();
  const current = await prisma.offlineTerminalNomination.findFirstOrThrow({
    where: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
  });
  await prisma.offlineTerminalNomination.update({
    where: { id: current.id },
    data: {
      terminalId: identity.terminalId, enrollmentId: identity.enrollmentId,
      keyId: identity.keyId, version: current.version + 1,
    },
  });
  if (prepared) await prepare(identity, cashier.userId);
  return identity;
}

/** An offline command the server accepted into this enrollment's journal (null: an online one).
 * Returns its digest: the journal hash the watermark names. */
async function acceptOfflineJournalEntry(identity: TerminalIdentity, offlineSequence: bigint | null) {
  const requestDigest = randomBytes(32).toString("hex");
  await prisma.terminalCommandReceipt.create({
    data: {
      tenantId: identity.tenantId, branchId: identity.branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, commandId: randomUUID(),
      operation: "offline_sale", requestDigest, offlineSequence,
      actorUserId: fx.clerkId, command: { contractVersion: 1 }, result: { status: "accepted" },
    },
  });
  return requestDigest;
}

/** A journal entry the server refused and kept for review (P5 #51 `offline_journal_review`). */
async function retainJournalReview(identity: TerminalIdentity, sequence: bigint, outcome: "held" | "rejected" | "conflict", errorCode: string) {
  await prisma.offlineJournalReview.create({
    data: {
      tenantId: identity.tenantId, branchId: identity.branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, recordKind: "command", recordId: randomUUID(),
      sequence, recordHash: randomBytes(32).toString("hex"), outcome, errorCode,
      envelope: { contractVersion: 1 }, receivedByUserId: fx.clerkId,
    },
  });
}
