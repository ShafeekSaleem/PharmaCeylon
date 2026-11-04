import { generateKeyPairSync } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { buildSignedStockSnapshot, verifyStockSnapshot } from "./stock-snapshot";

const identity = {
  tenantId: "tenant", branchId: "branch", terminalId: "terminal",
  enrollmentId: "enrollment", keyId: "device-key",
};
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = { keyId: "server-key", privateKey };
const verifier = { keyId: signer.keyId, publicKey };

function fixture() {
  const batch = {
    id: "batch", productId: "product",
    expiryDate: new Date("2099-12-31T00:00:00Z"),
    sellingPrice: new Prisma.Decimal("12.34"),
    stock: { onHandQty: 12, quarantinedQty: 3, reservedQty: 2 },
  };
  const tx = {
    offlineStockSnapshot: {
      findFirst: jest.fn().mockResolvedValue({ version: 3 }),
      create: jest.fn().mockResolvedValue({}),
    },
    offlineTerminalNomination: { findFirst: jest.fn().mockResolvedValue({ id: "nomination" }) },
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ timezone: "Asia/Colombo" }) },
    tenantSettings: { findUnique: jest.fn().mockResolvedValue({ vatRatePercent: new Prisma.Decimal("18.25") }) },
    batch: { findMany: jest.fn().mockResolvedValue([batch, {
      ...batch, id: "reserved", stock: { onHandQty: 2, quarantinedQty: 0, reservedQty: 2 },
    }]) },
  };
  const transaction = jest.fn((work: (client: typeof tx) => unknown) => work(tx));
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  const readState = jest.fn().mockResolvedValue({
    includedThroughSequence: 3, includedThroughHash: "a".repeat(64),
    reviewRequiredBatchIds: new Set(["batch"]),
  });
  return { tx, transaction, readState, build: () => buildSignedStockSnapshot(prisma, identity, signer, 0, readState) };
}

it("signs eligible balances and the watermark from the same repeatable-read view", async () => {
  const { tx, transaction, readState, build } = fixture();
  const signed = await build();
  expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
  expect(readState).toHaveBeenCalledWith(tx, identity);
  expect(tx.batch.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      tenantId: identity.tenantId, branchId: identity.branchId, needsExpiryReview: false,
      product: expect.objectContaining({ isActive: true, isControlled: false, requiresPrescription: false }),
    }),
  }));
  expect(signed.payload).toMatchObject({
    snapshotVersion: 4, includedThroughSequence: 3, includedThroughHash: "a".repeat(64),
    lines: [{
      batchId: "batch", availableQuantity: 7, stockReviewRequired: true,
      unitPriceMinor: 1234, taxBasisPoints: 1825, sellBefore: Date.parse("2099-12-31T18:30:00Z"),
    }],
  });
  expect(verifyStockSnapshot(signed, identity, verifier)).toBe(true);
  expect(tx.offlineStockSnapshot.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      enrollmentId: identity.enrollmentId, version: 4, id: signed.payload.snapshotId, envelope: signed,
    }),
  });
  expect(verifyStockSnapshot(signed, { ...identity, branchId: "other" }, verifier)).toBe(false);
  expect(verifyStockSnapshot(signed, identity, { ...verifier, keyId: "other" })).toBe(false);
  expect(verifyStockSnapshot({
    ...signed, payload: { ...signed.payload, snapshotVersion: 5 },
  }, identity, verifier)).toBe(false);
});

it("refuses to read snapshot data without a current matching nomination", async () => {
  const { tx, readState, build } = fixture();
  tx.offlineTerminalNomination.findFirst.mockResolvedValue(null);
  await expect(build()).rejects.toThrow("Terminal authorization failed");
  expect(tx.batch.findMany).not.toHaveBeenCalled();
  expect(readState).not.toHaveBeenCalled();
});
