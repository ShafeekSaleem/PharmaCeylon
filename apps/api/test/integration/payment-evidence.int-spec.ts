import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { businessDateKey } from "../../src/common/business-date.util";
import { nextTenantDocumentNumber } from "../../src/common/document-sequence.util";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { AccessService } from "../../src/security/access.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../src/security/operation-authorization.service";
import { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { SupplierLedgerService } from "../../src/purchasing/ledger/supplier-ledger.service";
import { SupplierPaymentEvidenceService } from "../../src/purchasing/ledger/supplier-payment-evidence.service";
import { EvidencedPaymentRecordingService } from "../../src/purchasing/ledger/evidenced-payment-recording.service";
import {
  EVIDENCED_PAYMENT_OPERATION,
  EvidencedPayment,
} from "../../src/purchasing/ledger/payment-evidence-material";
import { createPrisma, createTenant, TenantFixture } from "./fixtures";

const prisma = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const access = new AccessService(proxy as never, {} as never);
const audit = new AuditService(proxy as never);
const evidence = new SupplierPaymentEvidenceService(
  proxy as never,
  audit,
  access,
);
const port = new MandatoryOperationEvidence(undefined, evidence);
const authorization = new OperationAuthorizationService(
  access,
  {} as never,
  port,
  new ManagementApprovalsService(access, audit),
);
const ledger = new SupplierLedgerService(proxy as never, audit);
const recording = new EvidencedPaymentRecordingService(
  proxy as never,
  ledger,
  evidence,
  authorization,
);
let fx: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (userId = fx.managerId): RequestUser => ({
  userId,
  tenantId: fx.tenantId,
  tokenVersion: 0,
  branchRoles: [],
  email: "payment@it.test",
  fullName: "Payment operator",
  authMethod: "bearer",
});
const file = (text = randomUUID()) =>
  ({
    buffer: Buffer.from(`%PDF-1.7\nSupporting payment document ${text}\n%%EOF`),
    mimetype: "application/pdf",
    originalname: "bank-record.pdf",
  }) as Express.Multer.File;
async function material(
  method: EvidencedPayment["method"] = "bank_transfer",
  amount = "25.00",
) {
  const paidOn = businessDateKey("Asia/Colombo");
  const invoice = await prisma.supplierInvoice.create({
    data: {
      tenantId: fx.tenantId,
      branchId: branch(),
      supplierId: fx.supplierId,
      invoiceNumber: randomUUID(),
      source: "supplier",
      invoiceDate: new Date(`${paidOn}T00:00:00Z`),
      dueDate: new Date(`${paidOn}T00:00:00Z`),
      subtotalAmount: 100,
      totalAmount: 100,
      createdBy: fx.ownerId,
    },
  });
  const payment: EvidencedPayment = {
    supplierId: fx.supplierId,
    paidOn,
    method,
    amount,
    reference: randomUUID(),
    notes: null,
    allocations: [{ invoiceId: invoice.id, amount }],
  };
  return { payment, invoice };
}
async function uploaded(method?: EvidencedPayment["method"], amount?: string) {
  const { payment, invoice } = await material(method, amount);
  const document = file();
  const saved = await evidence.upload(
    user(),
    branch(),
    randomUUID(),
    payment,
    document,
  );
  return {
    body: { evidenceId: saved.evidenceId, payment: saved.payment },
    payment,
    invoice,
    document,
    saved,
  };
}
const context = (body: unknown) => ({
  tenantId: fx.tenantId,
  branchId: branch(),
  actorUserId: fx.managerId,
  operation: EVIDENCED_PAYMENT_OPERATION,
  body,
});
const countPayments = () =>
  prisma.supplierPayment.count({ where: { tenantId: fx.tenantId } });
beforeAll(async () => {
  fx = await createTenant(prisma, "payment-evidence");
  await prisma.userBranchRole.createMany({
    data: [
      {
        tenantId: fx.tenantId,
        branchId: branch(),
        userId: fx.ownerId,
        role: "owner",
      },
      {
        tenantId: fx.tenantId,
        branchId: branch(),
        userId: fx.managerId,
        role: "manager",
      },
      {
        tenantId: fx.tenantId,
        branchId: branch(),
        userId: fx.clerkId,
        role: "inventory_clerk",
      },
    ],
  });
});
afterAll(() => prisma.$disconnect());
afterEach(() => jest.restoreAllMocks());

it.each(["bank_transfer", "cheque", "card"] as const)(
  "records evidenced %s remotely with one atomic ledger/audit/evidence link",
  async (method) => {
    const { body, invoice, saved } = await uploaded(method);
    expect(
      await prisma.supplierPayment.count({
        where: {
          tenantId: fx.tenantId,
          allocations: { some: { invoiceId: invoice.id } },
        },
      }),
    ).toBe(0);
    const result = await recording.record(user(), branch(), body, randomUUID());
    expect(result).toMatchObject({
      method,
      amount: "25.00",
      evidenceId: saved.evidenceId,
    });
    const proof = await prisma.supplierPaymentEvidence.findUniqueOrThrow({
      where: { id: saved.evidenceId },
    });
    expect(proof.consumedPaymentId).toBe(result.id);
    expect(
      (
        await prisma.supplierInvoice.findUniqueOrThrow({
          where: { id: invoice.id },
        })
      ).paidAmount.toFixed(2),
    ).toBe("25.00");
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        tenantId: fx.tenantId,
        entityId: result.id,
        eventName: "supplier_payment.recorded",
      },
    });
    expect(event.payload).toMatchObject({
      evidenceId: saved.evidenceId,
      evidenceDigest: saved.materialDigest,
      uploadedBy: fx.managerId,
    });
  },
);

it("replays concurrent/lost responses and a later different key without another financial effect", async () => {
  const { body, invoice } = await uploaded();
  const key = randomUUID();
  const [a, b] = await Promise.all([
    recording.record(user(), branch(), body, key),
    recording.record(user(), branch(), body, key),
  ]);
  expect(a).toEqual(b);
  expect(
    (await recording.record(user(), branch(), body, randomUUID())).id,
  ).toBe(a.id);
  expect(
    await prisma.supplierPayment.count({
      where: {
        tenantId: fx.tenantId,
        allocations: { some: { invoiceId: invoice.id } },
      },
    }),
  ).toBe(1);
  expect(
    await prisma.auditEvent.count({
      where: {
        tenantId: fx.tenantId,
        entityId: a.id,
        eventName: "supplier_payment.recorded",
      },
    }),
  ).toBe(1);
});

it("rejects an idempotency key reused with another exact evidence/payment binding", async () => {
  const a = await uploaded();
  const b = await uploaded();
  const key = randomUUID();
  await recording.record(user(), branch(), a.body, key);
  await expect(recording.record(user(), branch(), b.body, key)).rejects.toThrow(
    /different payment/,
  );
  expect(
    (
      await prisma.supplierPaymentEvidence.findUniqueOrThrow({
        where: { id: b.saved.evidenceId },
      })
    ).consumedAt,
  ).toBeNull();
});

it("replays identical upload intake after its payment fully settles the invoice", async () => {
  const item = await uploaded("bank_transfer", "100.00");
  const result = await recording.record(user(), branch(), item.body);
  const retried = await evidence.upload(
    user(),
    branch(),
    item.saved.evidenceId.toUpperCase(),
    item.payment,
    item.document,
  );
  expect(retried.consumedPaymentId).toBe(result.id);
  expect(retried.evidenceId).toBe(item.saved.evidenceId);
  expect(
    await prisma.auditEvent.count({
      where: {
        tenantId: fx.tenantId,
        entityId: item.saved.evidenceId,
        eventName: "supplier_payment.evidence_uploaded",
      },
    }),
  ).toBe(1);
});

it.each(["amount", "method", "reference", "paidOn", "invoice"])(
  "rejects changed %s after upload",
  async (field) => {
    const { body, payment } = await uploaded();
    const other = await material();
    const changed = JSON.parse(JSON.stringify(payment)) as EvidencedPayment;
    if (field === "amount") {
      changed.amount = "20.00";
      changed.allocations[0]!.amount = "20.00";
    }
    if (field === "method") changed.method = "card";
    if (field === "reference") changed.reference = "different bank reference";
    if (field === "paidOn") changed.paidOn = "2026-01-01";
    if (field === "invoice")
      changed.allocations = [
        { invoiceId: other.invoice.id, amount: changed.amount },
      ];
    await expect(
      recording.record(user(), branch(), { ...body, payment: changed }),
    ).rejects.toMatchObject({
      response: { code: "PAYMENT_EVIDENCE_REQUIRED" },
    });
  },
);

it("never accepts another uploader's artifact, even when the caller is an owner", async () => {
  const { body } = await uploaded();
  await expect(
    recording.record(user(fx.ownerId), branch(), body),
  ).rejects.toMatchObject({ response: { code: "PAYMENT_EVIDENCE_REQUIRED" } });
});

it("scopes documents, invoice allocations and evidence downloads to the tenant and branch", async () => {
  const item = await uploaded();
  await expect(
    evidence.read(user(), fx.otherBranchId, item.saved.evidenceId),
  ).rejects.toThrow();
  const other = await createTenant(prisma, "foreign-payment");
  await expect(
    recording.record(
      { ...user(), tenantId: other.tenantId },
      other.mainBranchId,
      item.body,
    ),
  ).rejects.toThrow();
  const invoice = await prisma.supplierInvoice.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.otherBranchId,
      supplierId: fx.supplierId,
      invoiceNumber: randomUUID(),
      source: "supplier",
      invoiceDate: new Date(),
      dueDate: new Date(),
      subtotalAmount: 10,
      totalAmount: 10,
      createdBy: fx.ownerId,
    },
  });
  await expect(
    evidence.upload(
      user(),
      branch(),
      randomUUID(),
      {
        ...item.payment,
        amount: "10.00",
        allocations: [{ invoiceId: invoice.id, amount: "10.00" }],
      },
      file(),
    ),
  ).rejects.toMatchObject({ response: { code: "PAYMENT_EVIDENCE_REQUIRED" } });
});

it("invalidates the binding when the original invoice material changes", async () => {
  const item = await uploaded();
  await prisma.supplierInvoice.update({
    where: { id: item.invoice.id },
    data: { totalAmount: 101 },
  });
  await expect(
    recording.record(user(), branch(), item.body),
  ).rejects.toMatchObject({ response: { code: "PAYMENT_EVIDENCE_REQUIRED" } });
});

it("retains immutable bytes/material and supports revocation plus corrected unused uploads", async () => {
  const item = await uploaded();
  await expect(
    prisma.supplierPaymentEvidence.update({
      where: { id: item.saved.evidenceId },
      data: { content: Buffer.from("replacement") },
    }),
  ).rejects.toThrow(/immutable/);
  await expect(
    prisma.supplierPaymentEvidence.delete({
      where: { id: item.saved.evidenceId },
    }),
  ).rejects.toThrow(/cannot be deleted/);
  await expect(
    evidence.upload(
      user(),
      branch(),
      randomUUID(),
      item.payment,
      item.document,
    ),
  ).rejects.toThrow(/already supports/);
  await evidence.revoke(
    user(),
    branch(),
    item.saved.evidenceId,
    "Wrong binding; retain history",
  );
  await expect(
    recording.record(user(), branch(), item.body),
  ).rejects.toMatchObject({ response: { code: "PAYMENT_EVIDENCE_REQUIRED" } });
  const corrected = await evidence.upload(
    user(),
    branch(),
    randomUUID(),
    item.payment,
    item.document,
  );
  expect(corrected.evidenceId).not.toBe(item.saved.evidenceId);
  expect(
    Buffer.from(
      (await evidence.read(user(), branch(), item.saved.evidenceId)).content,
    ),
  ).toEqual(item.document.buffer);
});

it("rolls back payment, allocations, settlement, evidence consumption and idempotency on audit failure", async () => {
  const item = await uploaded();
  const before = await countPayments();
  const original = audit.log.bind(audit);
  jest.spyOn(audit, "log").mockImplementation(async (input, tx) => {
    if (input.eventName === "supplier_payment.recorded")
      throw new Error("audit unavailable");
    return original(input, tx);
  });
  await expect(
    recording.record(user(), branch(), item.body, "audit-rollback"),
  ).rejects.toThrow(/audit unavailable/);
  expect(await countPayments()).toBe(before);
  expect(
    (
      await prisma.supplierInvoice.findUniqueOrThrow({
        where: { id: item.invoice.id },
      })
    ).paidAmount.toFixed(2),
  ).toBe("0.00");
  expect(
    (
      await prisma.supplierPaymentEvidence.findUniqueOrThrow({
        where: { id: item.saved.evidenceId },
      })
    ).consumedAt,
  ).toBeNull();
  expect(
    await prisma.idempotencyRecord.count({
      where: { tenantId: fx.tenantId, idempotencyKey: "audit-rollback" },
    }),
  ).toBe(0);
});

async function actualWait(
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  start: () => Promise<unknown>,
  duringWait: () => Promise<unknown>,
) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const blocker = prisma.$transaction(
    async (tx) => {
      await lock(tx);
      const rows = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      ready(rows[0]!.pid);
      await gate;
    },
    { timeout: 30_000 },
  );
  const pid = await acquired;
  const outcome = Promise.allSettled([start()]);
  try {
    let waited = false;
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.$queryRaw<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY(pg_blocking_pids(pid))) AS waiting`;
      if (rows[0]!.waiting) {
        waited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waited).toBe(true);
    await duringWait();
    release();
    await blocker;
    expect((await outcome)[0]!.status).toBe("rejected");
  } finally {
    release();
    await Promise.allSettled([blocker, outcome]);
  }
}

it("rechecks current pay permission after the original invoice lock wait", async () => {
  const item = await uploaded();
  try {
    await actualWait(
      (tx) =>
        tx.$queryRaw`SELECT id FROM supplier_invoice WHERE id = ${item.invoice.id}::uuid FOR UPDATE`,
      () => recording.record(user(), branch(), item.body),
      () =>
        prisma.userBranchRole.updateMany({
          where: { tenantId: fx.tenantId, userId: fx.managerId },
          data: { role: "cashier" },
        }),
    );
    expect(
      (
        await prisma.supplierPaymentEvidence.findUniqueOrThrow({
          where: { id: item.saved.evidenceId },
        })
      ).consumedAt,
    ).toBeNull();
  } finally {
    await prisma.userBranchRole.updateMany({
      where: { tenantId: fx.tenantId, userId: fx.managerId },
      data: { role: "manager" },
    });
  }
});

it("rechecks authority after a later document-sequence wait and rolls back all effects", async () => {
  const item = await uploaded();
  const before = await countPayments();
  await prisma.$transaction((tx) =>
    nextTenantDocumentNumber(tx, fx.tenantId, "supplier_payment", "PAY-"),
  );
  try {
    await actualWait(
      (tx) =>
        tx.$queryRaw`SELECT id FROM document_sequence WHERE tenant_id = ${fx.tenantId}::uuid AND doc_type = 'tenant:supplier_payment' FOR UPDATE`,
      () => recording.record(user(), branch(), item.body),
      () =>
        prisma.userBranchRole.updateMany({
          where: { tenantId: fx.tenantId, userId: fx.managerId },
          data: { role: "cashier" },
        }),
    );
    expect(await countPayments()).toBe(before);
    expect(
      (
        await prisma.supplierPaymentEvidence.findUniqueOrThrow({
          where: { id: item.saved.evidenceId },
        })
      ).consumedAt,
    ).toBeNull();
  } finally {
    await prisma.userBranchRole.updateMany({
      where: { tenantId: fx.tenantId, userId: fx.managerId },
      data: { role: "manager" },
    });
  }
});

it("sees evidence revoked while waiting for the invoice and records nothing", async () => {
  const item = await uploaded();
  const before = await countPayments();
  await actualWait(
    (tx) =>
      tx.$queryRaw`SELECT id FROM supplier_invoice WHERE id = ${item.invoice.id}::uuid FOR UPDATE`,
    () => recording.record(user(), branch(), item.body),
    () =>
      evidence.revoke(
        user(),
        branch(),
        item.saved.evidenceId,
        "Revoked before recording",
      ),
  );
  expect(await countPayments()).toBe(before);
});

it("fails closed without a real provider and never maps cash/other or legacy paths to bank authority", async () => {
  const item = await uploaded();
  await expect(
    prisma.$transaction((tx) =>
      new MandatoryOperationEvidence().bankPayment(tx, context(item.body)),
    ),
  ).rejects.toMatchObject({ response: { code: "PAYMENT_EVIDENCE_REQUIRED" } });
  await expect(
    prisma.$transaction((tx) =>
      port.bankPayment(tx, {
        ...context(item.body),
        operation: "POST /api/v1/purchasing/payments",
      }),
    ),
  ).rejects.toMatchObject({ response: { code: "PAYMENT_EVIDENCE_REQUIRED" } });
  for (const method of ["cash", "other"])
    await expect(
      recording.record(user(), branch(), {
        ...item.body,
        payment: { ...item.payment, method },
      }),
    ).rejects.toThrow(/Invalid payment evidence/);
  await expect(
    recording.record(user(), branch(), {
      verified: true,
      payment: item.payment,
      evidenceId: item.saved.evidenceId,
    }),
  ).rejects.toThrow();
});
