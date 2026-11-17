import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  ExternalCardAttemptRecord,
  OfflineBusinessHoursAcknowledgement,
  OfflineSaleIncident,
  TerminalEnrollmentCommand,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { BusinessHoursAcknowledgements } from "../../src/terminals/business-hours-acknowledgements.service";
import {
  LocalAttendanceVerifier,
  type AttendanceExpectation,
} from "../../src/terminals/local-attendance.verifier";
import { OfflineSupportRecords } from "../../src/terminals/offline-support-records.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, commandText, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, TenantFixture } from "./fixtures";
import * as kit from "./offline-counter.kit";

/** P1 #47: counter-signed sale-incident notes and external-card attempt events. */
const prisma = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const audit = new AuditService(proxy as never);
const access = new AccessService(proxy as never, {} as never);

class FixtureAttendance extends LocalAttendanceVerifier {
  readonly proofs = new Map<string, AttendanceExpectation>();
  allow(p: TerminalEnrollmentCommand) {
    const id = randomUUID();
    this.proofs.set(id, {
      purpose: "enrollment",
      identity: p.identity,
      actorUserId: p.requestedByUserId,
      registerId: p.registerId,
      tillId: p.tillId,
      payloadDigest: sha256(boundedCanonical(p)),
    });
    return id;
  }
  override async verify(_tx: Prisma.TransactionClient, proofId: string, expected: AttendanceExpectation) {
    if (boundedCanonical(this.proofs.get(proofId) ?? {}) !== boundedCanonical(expected))
      throw new Error("Unverified attendance");
    return proofId;
  }
}
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const support = new OfflineSupportRecords(access, audit, new BusinessHoursAcknowledgements(access, audit));

let fx: TenantFixture;
const user = (userId: string, tokenVersion = 0): RequestUser => ({
  userId,
  tenantId: fx.tenantId,
  tokenVersion,
  branchRoles: [],
  email: "support@it.test",
  fullName: "Support",
  authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
const now = Date.now();
const record = (raw: unknown, who = fx.clerkId, branchId = fx.mainBranchId, service = support) =>
  tx((c) => service.record(c, user(who), branchId, raw, now));
const code = (promise: Promise<unknown>) =>
  promise.then(() => "recorded", (e: { response?: { code?: string } }) => e.response?.code ?? String(e));

async function enrolledDevice() {
  const owner = user(fx.ownerId);
  const device = terminalDevice();
  const counter = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, `Counter ${randomUUID().slice(0, 6)}`));
  const enrollment = await tx((c) =>
    trust.beginEnrollment(c, owner, fx.mainBranchId, {
      registerId: counter.id,
      label: "Desk",
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
    }),
  );
  const identity = await tx((c) =>
    trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment)),
  );
  return { device, identity };
}
const incident = (identity: TerminalIdentity, overrides: Partial<OfflineSaleIncident> = {}): OfflineSaleIncident => ({
  contractVersion: 1,
  kind: "sale_incident",
  recordId: randomUUID(),
  identity,
  saleCommandId: randomUUID(),
  recordedByUserId: fx.clerkId,
  staffSignInId: randomUUID(),
  workSessionId: randomUUID(),
  recordedAt: now - 60_000,
  category: "quantity_error",
  description: "Handed over two units, three were entered",
  ...overrides,
});
type AttemptBinding = Pick<ExternalCardAttemptRecord, "attemptId" | "checkoutDraftId" | "reviewedSaleDigest" | "amountMinor" | "staffSignInId" | "workSessionId">;
const binding = (): AttemptBinding => ({
  attemptId: randomUUID(),
  checkoutDraftId: randomUUID(),
  reviewedSaleDigest: sha256(randomUUID()),
  amountMinor: 245_000,
  staffSignInId: randomUUID(),
  workSessionId: randomUUID(),
});
const cardEvent = (
  identity: TerminalIdentity,
  attempt: AttemptBinding,
  state: Record<string, unknown> = { state: "prepared" },
): ExternalCardAttemptRecord =>
  ({
    contractVersion: 1,
    kind: "external_card_attempt",
    recordId: randomUUID(),
    identity,
    ...attempt,
    recordedAt: now - 30_000,
    ...state,
  }) as ExternalCardAttemptRecord;
const approved = { state: "approved", providerReference: "RRN 610012345678", approvalCode: "004512", approvedAt: now - 40_000 };
const linked = (saleCommandId: string) => ({ state: "linked_to_sale", providerReference: "RRN 610012345678", saleCommandId });
const businessCounts = () =>
  Promise.all([
    prisma.sale.count({ where: { tenantId: fx.tenantId } }),
    prisma.salePayment.count({ where: { tenantId: fx.tenantId } }),
    prisma.stockLedger.count({ where: { tenantId: fx.tenantId } }),
    prisma.goodsReturn.count({ where: { tenantId: fx.tenantId } }),
  ]);

beforeAll(async () => {
  fx = await createTenant(prisma, "support-records");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "cashier" },
    ],
  });
});
afterAll(() => Promise.all([prisma.$disconnect(), kit.prisma.$disconnect()]));

describe("sale-incident notes", () => {
  it("persists the signed note as held evidence, replays identical uploads and moves nothing", async () => {
    const { device, identity } = await enrolledDevice();
    const before = await businessCounts();
    const payload = incident(identity);
    const signed = device.sign(payload, identity.keyId);
    const first = await record(signed);
    expect(first).toMatchObject({ recordId: payload.recordId, status: "held", heldReason: "sale_unverified", replayed: false });
    await expect(record(JSON.parse(JSON.stringify(signed)))).resolves.toEqual({ ...first, replayed: true });
    const rows = await prisma.offlineSupportRecord.findMany({ where: { tenantId: fx.tenantId, recordId: payload.recordId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "sale_incident",
      saleCommandId: payload.saleCommandId,
      incidentCategory: "quantity_error",
      description: payload.description,
      receivedByUserId: fx.clerkId,
      attemptId: null,
    });
    expect(rows[0]!.envelope).toEqual(signed);
    const audits = await prisma.auditEvent.findMany({ where: { tenantId: fx.tenantId, entityId: rows[0]!.id } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.payload)).not.toContain(payload.description);
    expect(await businessCounts()).toEqual(before);
  });

  it("refuses a card number in the note before anything is stored", async () => {
    const { device, identity } = await enrolledDevice();
    const signed = device.sign(incident(identity, { description: "Card 4111111111111111 was declined" }), identity.keyId);
    await expect(code(record(signed))).resolves.toBe("INVALID_COMMAND");
    expect(await prisma.offlineSupportRecord.count({ where: { enrollmentId: identity.enrollmentId } })).toBe(0);
  });
});

describe("external-card attempt events", () => {
  it("keeps each event of one attempt as its own held record", async () => {
    const { device, identity } = await enrolledDevice();
    const attempt = binding();
    const before = await businessCounts();
    const saleCommandId = randomUUID();
    for (const state of [{ state: "prepared" }, { state: "uncertain" }, approved, linked(saleCommandId)])
      await expect(record(device.sign(cardEvent(identity, attempt, state), identity.keyId))).resolves.toMatchObject({
        status: "held",
        heldReason: "payment_unverified",
      });
    const rows = await prisma.offlineSupportRecord.findMany({
      where: { tenantId: fx.tenantId, attemptId: attempt.attemptId },
      orderBy: { receivedAt: "asc" },
    });
    expect(rows.map((r) => r.cardState)).toEqual(["prepared", "uncertain", "approved", "linked_to_sale"]);
    expect(rows[2]).toMatchObject({ providerReference: "RRN 610012345678", approvalCode: "004512", amountMinor: BigInt(245_000) });
    expect(rows[3]).toMatchObject({ saleCommandId, approvalCode: null });
    expect(await businessCounts()).toEqual(before);
  });

  it("holds an event that disagrees with its attempt's draft, amount, reference or linked sale", async () => {
    const { device, identity } = await enrolledDevice();
    const attempt = binding();
    await record(device.sign(cardEvent(identity, attempt, approved), identity.keyId));
    await record(device.sign(cardEvent(identity, attempt, linked(randomUUID())), identity.keyId));
    const mismatches = [
      cardEvent(identity, { ...attempt, amountMinor: attempt.amountMinor + 1 }),
      cardEvent(identity, { ...attempt, checkoutDraftId: randomUUID() }),
      cardEvent(identity, attempt, { ...approved, providerReference: "RRN 610099999999" }),
      cardEvent(identity, attempt, linked(randomUUID())),
      // A second approval of the same attempt must be the same approval.
      cardEvent(identity, attempt, { ...approved, approvalCode: "009999" }),
      cardEvent(identity, attempt, { ...approved, approvedAt: approved.approvedAt + 1_000 }),
    ];
    for (const event of mismatches)
      await expect(record(device.sign(event, identity.keyId))).resolves.toMatchObject({ status: "held", heldReason: "attempt_mismatch" });
    // Another attempt with the same amount is unaffected.
    await expect(record(device.sign(cardEvent(identity, binding()), identity.keyId))).resolves.toMatchObject({
      heldReason: "payment_unverified",
    });
  });

  it("re-reads the uploader's authority after the attempt-lock wait", async () => {
    const { device, identity } = await enrolledDevice();
    const attempt = binding();
    const signed = device.sign(cardEvent(identity, attempt), identity.keyId);
    const key = `card_attempt:${fx.tenantId}:${identity.enrollmentId}:${attempt.attemptId}`;
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = tx(async (c) => {
      await c.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await isLocked;
    const outcome = code(record(signed));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const rows = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'
            AND pid <> pg_backend_pid()`;
        waiting = Number(rows[0]?.count) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      // Signed out everywhere while the upload waits.
      await prisma.appUser.update({ where: { id: fx.clerkId }, data: { tokenVersion: { increment: 1 } } });
    } finally {
      release();
      await holder;
    }
    try {
      await expect(outcome).resolves.toMatch(/Live branch authentication required/);
    } finally {
      await prisma.appUser.update({ where: { id: fx.clerkId }, data: { tokenVersion: 0 } });
    }
    expect(await prisma.offlineSupportRecord.count({ where: { tenantId: fx.tenantId, attemptId: attempt.attemptId } })).toBe(0);
  });

  it("serializes concurrent events of one attempt, so a disagreeing one is always caught", async () => {
    const { device, identity } = await enrolledDevice();
    const attempt = binding();
    const results = await Promise.all([
      record(device.sign(cardEvent(identity, attempt), identity.keyId)),
      record(device.sign(cardEvent(identity, { ...attempt, amountMinor: 1 }), identity.keyId)),
    ]);
    expect(results.map((r) => ("heldReason" in r ? r.heldReason : r.status)).sort()).toEqual([
      "attempt_mismatch",
      "payment_unverified",
    ]);
  });
});

describe("one record-ID space for every support kind", () => {
  it("serializes concurrent identical uploads into one record", async () => {
    const { device, identity } = await enrolledDevice();
    const signed = device.sign(cardEvent(identity, binding()), identity.keyId);
    const results = await Promise.all([record(signed), record(signed), record(signed)]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.offlineSupportRecord.count({ where: { recordId: signed.payload.recordId } })).toBe(1);
  });

  it("retains changed content under a used ID, including an ID used by another kind", async () => {
    const { device, identity } = await enrolledDevice();
    const note = incident(identity);
    const original = await record(device.sign(note, identity.keyId));
    const edited = device.sign({ ...note, description: "Actually four units" }, identity.keyId);
    const otherKind = device.sign({ ...cardEvent(identity, binding()), recordId: note.recordId }, identity.keyId);
    await expect(record(edited)).resolves.toMatchObject({ status: "conflict", originalRecordHash: original.recordHash, replayed: false });
    await expect(record(otherKind)).resolves.toMatchObject({ status: "conflict", originalRecordHash: original.recordHash });
    await expect(record(edited)).resolves.toMatchObject({ status: "conflict", replayed: true });
    const kept = await prisma.offlineSupportConflict.findMany({ where: { tenantId: fx.tenantId, recordId: note.recordId } });
    expect(kept.map((k) => k.kind).sort()).toEqual(["external_card_attempt", "sale_incident"]);
    expect(await prisma.offlineSupportRecord.count({ where: { recordId: note.recordId } })).toBe(1);
    await expect(record(device.sign(note, identity.keyId))).resolves.toEqual({ ...original, replayed: true });

    const ack: OfflineBusinessHoursAcknowledgement = {
      contractVersion: 1,
      kind: "business_hours_acknowledgement",
      recordId: randomUUID(),
      identity,
      grantId: randomUUID(),
      grantVersion: 1,
      nominationVersion: 1,
      offlineSessionId: randomUUID(),
      managerSignInId: randomUUID(),
      recordedAt: now - 60_000,
      startsAt: now - 60_000,
      endsAt: now + 60 * 60_000,
      reason: "Queue at closing time",
    };
    const hours = await record(device.sign(ack, identity.keyId));
    expect(hours).toMatchObject({ status: "held", heldReason: "grant_unverified" });
    await expect(record(device.sign(incident(identity, { recordId: ack.recordId }), identity.keyId))).resolves.toMatchObject({
      status: "conflict",
      originalRecordHash: hours.recordHash,
    });
    expect(await prisma.offlineSupportRecord.count({ where: { recordId: ack.recordId } })).toBe(0);
  });
});

describe("refusals and retention", () => {
  it("rejects another device's signature, a wrong branch, an untrusted clock and a stale uploader", async () => {
    const { device, identity } = await enrolledDevice();
    await expect(code(record(terminalDevice().sign(incident(identity), identity.keyId)))).resolves.toBe("INVALID_SIGNATURE");
    await expect(code(record(device.sign(incident(identity), identity.keyId), fx.clerkId, fx.otherBranchId))).resolves.toBe(
      "IDENTITY_MISMATCH",
    );
    await expect(code(record(device.sign(incident(identity, { recordedAt: now + 60 * 60_000 }), identity.keyId)))).resolves.toBe(
      "CLOCK_UNTRUSTED",
    );
    await expect(
      code(tx((c) => support.record(c, user(fx.clerkId, 99), fx.mainBranchId, device.sign(incident(identity), identity.keyId), now))),
    ).resolves.not.toBe("recorded");
    await expect(code(record(device.sign({ ...incident(identity), kind: "sale_refund" }, identity.keyId)))).resolves.toBe(
      "INVALID_COMMAND",
    );
    expect(await prisma.offlineSupportRecord.count({ where: { enrollmentId: identity.enrollmentId } })).toBe(0);
  });

  it("retains a revoked device's upload for reconciliation, still held", async () => {
    const { device, identity } = await enrolledDevice();
    await tx((c) => trust.revokeEnrollment(c, user(fx.ownerId), fx.mainBranchId, identity.enrollmentId, "Lost"));
    await expect(record(device.sign(cardEvent(identity, binding(), approved), identity.keyId))).resolves.toMatchObject({
      status: "held",
      heldReason: "enrollment_revoked",
    });
  });

  it("rolls back the record when its success audit fails", async () => {
    const { device, identity } = await enrolledDevice();
    class FailingAudit extends AuditService {
      override async log(): Promise<void> {
        throw new Error("audit unavailable");
      }
    }
    const failing = new FailingAudit(proxy as never);
    const broken = new OfflineSupportRecords(access, failing, new BusinessHoursAcknowledgements(access, failing));
    const signed = device.sign(incident(identity), identity.keyId);
    await expect(record(signed, fx.clerkId, fx.mainBranchId, broken)).rejects.toThrow("audit unavailable");
    expect(await prisma.offlineSupportRecord.count({ where: { recordId: signed.payload.recordId } })).toBe(0);
    await expect(record(signed)).resolves.toMatchObject({ status: "held", replayed: false });
  });

  it("keeps signed content immutable, the outcome final and conflicts permanent", async () => {
    const { device, identity } = await enrolledDevice();
    const note = incident(identity);
    await record(device.sign(note, identity.keyId));
    await record(device.sign({ ...note, category: "other" }, identity.keyId));
    const row = await prisma.offlineSupportRecord.findFirstOrThrow({ where: { recordId: note.recordId } });
    await expect(prisma.offlineSupportRecord.update({ where: { id: row.id }, data: { description: "Edited" } })).rejects.toThrow(/immutable/);
    await expect(prisma.offlineSupportRecord.delete({ where: { id: row.id } })).rejects.toThrow(/retained/);
    await prisma.offlineSupportRecord.update({ where: { id: row.id }, data: { status: "accepted", heldReason: null, verifiedAt: new Date() } });
    await expect(prisma.offlineSupportRecord.update({ where: { id: row.id }, data: { status: "rejected" } })).rejects.toThrow(/immutable/);
    const conflict = await prisma.offlineSupportConflict.findFirstOrThrow({ where: { recordId: note.recordId } });
    await expect(prisma.offlineSupportConflict.delete({ where: { id: conflict.id } })).rejects.toThrow(/retained/);
  });

  it("refuses rows whose columns do not match their kind or card state", async () => {
    const { identity } = await enrolledDevice();
    const base = {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId,
      keyId: identity.keyId,
      recordHash: "b".repeat(64),
      envelope: {},
      staffSignInId: randomUUID(),
      workSessionId: randomUUID(),
      recordedAt: new Date(),
      receivedByUserId: fx.clerkId,
    };
    const card = {
      ...base,
      kind: "external_card_attempt",
      attemptId: randomUUID(),
      checkoutDraftId: randomUUID(),
      reviewedSaleDigest: "c".repeat(64),
      amountMinor: BigInt(100),
    };
    for (const data of [
      { ...card, recordId: randomUUID(), cardState: "approved", providerReference: "RRN" }, // no approval code
      { ...card, recordId: randomUUID(), cardState: "prepared", description: "note" },
      { ...card, recordId: randomUUID(), cardState: "prepared", amountMinor: BigInt(0) },
      { ...base, recordId: randomUUID(), kind: "sale_incident", saleCommandId: randomUUID(), recordedByUserId: fx.clerkId, incidentCategory: "theft", description: "x" },
    ])
      await expect(prisma.offlineSupportRecord.create({ data })).rejects.toThrow(/offline_support_record_shape/);
  });
});

/**
 * P5 #51: held support evidence is promoted once its sign-in, shift, sale entry and card result
 * are on the server, whichever arrives first. Signed by a real nominated counter (`offline-counter.kit`).
 */
describe("promotion once the cited evidence is verified", () => {
  const RRN = "RRN 610099887766";
  const CODE = "771204";
  type Uploaded = { payload: { recordId: string } };

  /** A counter's outage: a signed sign-in, a shift and one card-paid sale, plus its card attempt. */
  function cardSale(c: kit.Counter, paid: { approvalCode?: string } = {}) {
    const j = kit.offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const known = c.snapshot.lines.find((l) => l.batchId === c.batches.main)!;
    const net = 2 * known.unitPriceMinor;
    const total = net + Number((BigInt(net) * BigInt(known.taxBasisPoints) + 5000n) / 10000n);
    const approvedAt = j.offlineStartedAt + 1500;
    const sale = j.sale(cashierIn, [[c.batches.main!, 2]], {
      payments: [{ method: "external_card", amountMinor: total, providerReference: RRN, approvalCode: paid.approvalCode ?? CODE, approvedAt }],
    });
    const { staffSignInId, session } = cashierIn.payload;
    const attempt = {
      attemptId: randomUUID(), checkoutDraftId: randomUUID(), reviewedSaleDigest: sha256(randomUUID()),
      amountMinor: total, staffSignInId, workSessionId: session.workSessionId,
    };
    const card = (state: Record<string, unknown>, at: number) => c.device.sign({
      contractVersion: 1, kind: "external_card_attempt", recordId: randomUUID(), identity: c.identity,
      ...attempt, recordedAt: at, ...state,
    } as ExternalCardAttemptRecord, c.identity.keyId);
    const events = [
      card({ state: "prepared" }, approvedAt - 500),
      card({ state: "approved", providerReference: RRN, approvalCode: CODE, approvedAt }, approvedAt + 100),
      card({ state: "linked_to_sale", providerReference: RRN, saleCommandId: sale.payload.commandId }, approvedAt + 200),
    ];
    const incident = c.device.sign({
      contractVersion: 1, kind: "sale_incident", recordId: randomUUID(), identity: c.identity,
      saleCommandId: sale.payload.commandId, recordedByUserId: c.cashier.userId, staffSignInId,
      workSessionId: session.workSessionId, recordedAt: approvedAt + 300, category: "payment_uncertain",
      description: "Card terminal printed twice",
    } satisfies OfflineSaleIncident, c.identity.keyId);
    return { cashierIn, open, sale, events, incident, records: [...events, incident] as never[] };
  }
  const stored = (c: kit.Counter, recordId: string) =>
    kit.prisma.offlineSupportRecord.findUniqueOrThrow({
      where: { tenantId_enrollmentId_recordId: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId, recordId } },
    });
  const statuses = (response: Awaited<ReturnType<typeof kit.sync>>) =>
    response.payload.supportAcknowledgements.map((a) => a.status);

  it("holds records that arrive before their sign-in and sale, then accepts them when the journal follows", async () => {
    const c = await kit.counter(undefined, { externalCard: true });
    const s = cardSale(c);
    const first = await kit.sync(c, { supportRecords: s.records });
    expect(statuses(first)).toEqual(["held", "held", "held", "held"]);
    for (const r of s.records as Uploaded[])
      expect(await stored(c, r.payload.recordId)).toMatchObject({ status: "held", heldReason: "sign_in_unverified" });
    expect(first.payload.supportEvidence).toEqual({
      heldRecords: 4, rejectedRecords: 0, unresolvedCardAttempts: 1,
      supportRecordsAccepted: false, paymentAttemptsResolved: false,
    });

    // The journal arrives later; no record has to be sent again.
    const second = await kit.sync(c, { staffSignIns: [s.cashierIn], commands: [s.open, s.sale] });
    expect(second.payload.acknowledgements.map((a) => a.status)).toEqual(["committed", "committed"]);
    expect(second.payload.supportEvidence).toEqual({
      heldRecords: 0, rejectedRecords: 0, unresolvedCardAttempts: 0,
      supportRecordsAccepted: true, paymentAttemptsResolved: true,
    });
    for (const r of s.records as Uploaded[])
      expect(await stored(c, r.payload.recordId)).toMatchObject({ status: "accepted", heldReason: null, verifiedAt: expect.any(Date) });

    // A resend learns the outcome; nothing moves twice.
    expect(statuses(await kit.sync(c, { supportRecords: s.records }))).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);
    expect(await kit.prisma.auditEvent.count({
      where: { tenantId: c.fx.tenantId, eventName: "terminal.support_record_accepted" },
    })).toBe(4);
  });

  it("accepts records in the same upload as the entries they cite", async () => {
    const c = await kit.counter(undefined, { externalCard: true });
    const s = cardSale(c);
    const response = await kit.sync(c, { staffSignIns: [s.cashierIn], commands: [s.open, s.sale], supportRecords: s.records });
    expect(statuses(response)).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    expect(response.payload.supportEvidence).toMatchObject({ supportRecordsAccepted: true, paymentAttemptsResolved: true });
  });

  it("says what each record still waits on, and a prepared attempt with no result stays unresolved", async () => {
    const c = await kit.counter(undefined, { externalCard: true });
    const s = cardSale(c);
    const [prepared, approved] = s.events;
    // The sign-in is uploaded but not the shift or sale: each record names the next missing piece.
    const response = await kit.sync(c, { staffSignIns: [s.cashierIn], supportRecords: [prepared, approved, s.incident] as never[] });
    expect(await stored(c, prepared!.payload.recordId)).toMatchObject({ status: "held", heldReason: "shift_unverified" });
    expect(response.payload.supportAcknowledgements[0]).toMatchObject({
      status: "held", error: { code: "RECONCILIATION_REQUIRED", message: expect.stringContaining("shift_unverified") },
    });
    await kit.sync(c, { commands: [s.open] });
    // Prepared cites no card result: accepted. The approval waits for its sale link.
    expect(await stored(c, prepared!.payload.recordId)).toMatchObject({ status: "accepted" });
    expect(await stored(c, approved!.payload.recordId)).toMatchObject({ status: "held", heldReason: "payment_unverified" });
    expect(await stored(c, s.incident.payload.recordId)).toMatchObject({ status: "held", heldReason: "sale_unverified" });
    expect(await kit.supportEvidence.status(kit.prisma as never, c.identity)).toEqual({
      heldRecords: 2, rejectedRecords: 0, unresolvedCardAttempts: 1,
      supportRecordsAccepted: false, paymentAttemptsResolved: false,
    });

    // A manager sees why each is held, and whether the counter's next upload clears it.
    const held = await kit.supportEvidence.listHeld(c.owner, c.fx.mainBranchId);
    expect(held).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: approved!.payload.recordId, heldReason: "payment_unverified", clearsOnUpload: true, attemptId: expect.any(String) }),
      expect.objectContaining({ recordId: s.incident.payload.recordId, heldReason: "sale_unverified", clearsOnUpload: true }),
    ]));
    await expect(kit.supportEvidence.listHeld(c.cashier, c.fx.mainBranchId)).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
  });

  it("keeps a card link whose sale holds another approval held for a manager", async () => {
    const c = await kit.counter(undefined, { externalCard: true });
    const s = cardSale(c, { approvalCode: "000000" });
    const response = await kit.sync(c, { staffSignIns: [s.cashierIn], commands: [s.open, s.sale], supportRecords: s.records });
    expect(statuses(response)).toEqual(["accepted", "held", "held", "accepted"]);
    for (const e of s.events.slice(1))
      expect(await stored(c, e.payload.recordId)).toMatchObject({ status: "held", heldReason: "card_payment_mismatch" });
    expect(response.payload.supportEvidence).toMatchObject({ heldRecords: 2, paymentAttemptsResolved: false });
    const held = await kit.supportEvidence.listHeld(c.owner, c.fx.mainBranchId);
    expect(held.filter((h) => h.heldReason === "card_payment_mismatch")).toEqual([
      expect.objectContaining({ clearsOnUpload: false }), expect.objectContaining({ clearsOnUpload: false }),
    ]);
    // Uploading again changes nothing: a person decides.
    await kit.sync(c, { supportRecords: s.records });
    expect(await stored(c, s.events[1]!.payload.recordId)).toMatchObject({ status: "held", heldReason: "card_payment_mismatch" });
  });

  it("rejects a record whose sign-in is for someone the grant did not prepare", async () => {
    const c = await kit.counter(undefined, { externalCard: true });
    const s = cardSale(c);
    const stranger = c.device.sign({
      ...s.cashierIn.payload, staffSignInId: randomUUID(),
      session: { ...s.cashierIn.payload.session, staffUserId: c.owner.userId },
    }, c.identity.keyId);
    const note = c.device.sign({ ...s.incident.payload, recordId: randomUUID(), staffSignInId: stranger.payload.staffSignInId }, c.identity.keyId);
    const response = await kit.sync(c, { staffSignIns: [s.cashierIn, stranger], commands: [s.open, s.sale], supportRecords: [note as never] });
    expect(await stored(c, note.payload.recordId)).toMatchObject({ status: "rejected", heldReason: "staff_not_prepared" });
    expect(response.payload.supportEvidence).toMatchObject({ rejectedRecords: 1, supportRecordsAccepted: false });
  });

  it("keeps a revoked counter's upload held, and altered content under an ID as a conflict", async () => {
    const c = await kit.counter(undefined, { externalCard: true });
    const s = cardSale(c);
    await kit.sync(c, { staffSignIns: [s.cashierIn], commands: [s.open, s.sale], supportRecords: [s.incident as never] });
    expect(await stored(c, s.incident.payload.recordId)).toMatchObject({ status: "accepted" });

    // Altered content reusing the accepted ID: a conflict naming the original, which is untouched.
    const altered = c.device.sign({ ...s.incident.payload, description: "Changed afterwards" }, c.identity.keyId);
    const conflict = await kit.sync(c, { supportRecords: [altered as never] });
    expect(conflict.payload.supportAcknowledgements).toEqual([
      expect.objectContaining({ status: "held", error: expect.objectContaining({ code: "REPLAY_CONFLICT" }) }),
    ]);
    expect(await stored(c, s.incident.payload.recordId))
      .toMatchObject({ status: "accepted", recordHash: sha256(commandText(s.incident.payload)) });

    await kit.prisma.$transaction((t) => kit.trust.revokeEnrollment(t, c.owner, c.fx.mainBranchId, c.identity.enrollmentId, "Lost"));
    const late = c.device.sign({ ...s.incident.payload, recordId: randomUUID() }, c.identity.keyId);
    await kit.sync(c, { supportRecords: [late as never] });
    expect(await stored(c, late.payload.recordId)).toMatchObject({ status: "held", heldReason: "enrollment_revoked" });
    expect(await kit.supportEvidence.listHeld(c.owner, c.fx.mainBranchId))
      .toEqual([expect.objectContaining({ recordId: late.payload.recordId, clearsOnUpload: false })]);
  });
});
