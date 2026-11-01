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
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, TenantFixture } from "./fixtures";

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
afterAll(() => prisma.$disconnect());

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
    ];
    for (const event of mismatches)
      await expect(record(device.sign(event, identity.keyId))).resolves.toMatchObject({ status: "held", heldReason: "attempt_mismatch" });
    // Another attempt with the same amount is unaffected.
    await expect(record(device.sign(cardEvent(identity, binding()), identity.keyId))).resolves.toMatchObject({
      heldReason: "payment_unverified",
    });
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
