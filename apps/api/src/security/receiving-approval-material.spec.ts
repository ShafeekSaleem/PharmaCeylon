import { Prisma } from "@prisma/client";
import { documentReview, goodsReturnMaterial, preparedReceiptMaterial } from "./receiving-approval-material";

const receipt = (payload: object) => ({ purchaseOrderId: "po", payload }) as never;
const order = (receivedQty: number, approvalVersion = 3) => ({
  approvalVersion,
  items: [
    { id: "b", receivedQty: 0, freeQty: 0, rejectedQty: 0 },
    { id: "a", receivedQty, freeQty: 0, rejectedQty: 0 },
  ],
});
const digest = (material: Prisma.InputJsonObject) => documentReview("prepared_receipt", 1, material).expectedDigest;

describe("prepared receipt approval material", () => {
  const delivery = { lines: [{ productId: "p", batchNo: "B1", receivedQty: 10 }] };

  it("binds the delivery, the order revision and what each line had already received", () => {
    const base = digest(preparedReceiptMaterial(receipt(delivery), order(0)));
    expect(digest(preparedReceiptMaterial(receipt(delivery), order(0)))).toBe(base);
    // A delivery booked in between, an order edit or a different delivery all need fresh approval.
    expect(digest(preparedReceiptMaterial(receipt(delivery), order(4)))).not.toBe(base);
    expect(digest(preparedReceiptMaterial(receipt(delivery), order(0, 4)))).not.toBe(base);
    expect(digest(preparedReceiptMaterial(receipt({ lines: [{ ...delivery.lines[0], receivedQty: 9 }] }), order(0)))).not.toBe(base);
  });

  it("does not depend on the order the lines were read in", () => {
    const reversed = { ...order(2), items: [...order(2).items].reverse() };
    expect(digest(preparedReceiptMaterial(receipt(delivery), reversed)))
      .toBe(digest(preparedReceiptMaterial(receipt(delivery), order(2))));
  });
});

describe("supplier return approval material", () => {
  const doc = (notes: string, qty = 3) => ({
    type: "supplier", customerName: null, saleId: null, supplierId: "s", purchaseOrderId: null, goodsReceiptId: null,
    amount: new Prisma.Decimal(30), reason: "Damaged", reasonCode: null, notes, status: "pending_approval",
    items: [{ id: "i", productId: "p", batchId: "b", qty, unitPrice: new Prisma.Decimal(10), disposition: null }],
  }) as never;

  it("covers lines and amounts but not notes or status", () => {
    expect(goodsReturnMaterial(doc("first"))).toEqual(goodsReturnMaterial(doc("second")));
    expect(goodsReturnMaterial(doc("first", 4))).not.toEqual(goodsReturnMaterial(doc("first")));
  });
});
