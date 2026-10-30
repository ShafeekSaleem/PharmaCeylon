import { randomUUID } from "node:crypto";
import { parseEvidencedPayment } from "./payment-evidence-material";
import { SupplierPaymentEvidenceService } from "./supplier-payment-evidence.service";
const invoiceId = randomUUID();
const payment = {
  supplierId: randomUUID(),
  paidOn: "2026-10-01",
  amount: "25.00",
  method: "bank_transfer",
  reference: "BANK-123",
  notes: null,
  allocations: [{ invoiceId, amount: "25.00" }],
};
it.each([
  { method: "cash" },
  { method: "other" },
  { verified: true },
  { reference: " " },
  { amount: "Infinity" },
  { amount: "25.001" },
  { paidOn: "2026-02-30" },
  { allocations: [] },
  { allocations: [{ invoiceId, amount: "20.00" }] },
  {
    allocations: [
      { invoiceId, amount: "10.00" },
      { invoiceId, amount: "15.00" },
    ],
  },
])(
  "rejects a non-exact, unsupported or ambiguous payment binding: %o",
  (change) => {
    expect(() => parseEvidencedPayment({ ...payment, ...change })).toThrow();
  },
);
it("normalizes money and UUID case before saving exact bindings", () => {
  expect(
    parseEvidencedPayment({
      ...payment,
      supplierId: payment.supplierId.toUpperCase(),
      amount: "25",
      allocations: [{ invoiceId: invoiceId.toUpperCase(), amount: "25" }],
    }),
  ).toEqual(payment);
});
it.each([
  {
    buffer: Buffer.from("https://example.invalid/public-receipt.webp"),
    mimetype: "image/webp",
  },
  { buffer: Buffer.from("%PDF-1.7\nbody\n%%EOF"), mimetype: "image/png" },
  { buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: "application/pdf" },
])(
  "rejects fake/mislabeled/oversized artifacts before any durable write",
  async (file) => {
    const prisma = { $transaction: jest.fn() };
    const service = new SupplierPaymentEvidenceService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.upload(
        {} as never,
        randomUUID(),
        randomUUID(),
        payment,
        file as Express.Multer.File,
      ),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  },
);
