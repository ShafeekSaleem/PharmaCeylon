import { approvalMaterialDigest } from "./approval-material-digest";
import { boundedCanonical, sha256 } from "../terminals/terminal-wire";

it("preserves the digest of already-issued small documents", () => {
  const material = { items: [{ qty: 12, price: "1.50" }], note: null };
  expect(approvalMaterialDigest("stocktake", material)).toBe(sha256(boundedCanonical({
    kind: "approval_material", documentType: "stocktake", material,
  })));
});

it("hashes document-sized material deterministically without relaxing signed command limits", () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), qty: i, detail: "reviewed" }));
  expect(() => boundedCanonical({ items })).toThrow();
  expect(approvalMaterialDigest("stocktake", { items })).toBe(
    approvalMaterialDigest("stocktake", { items: items.map(l => ({ detail: l.detail, qty: l.qty, id: l.id })) }),
  );
  expect(approvalMaterialDigest("stocktake", { items })).not.toBe(approvalMaterialDigest("transfer", { items }));
  expect(approvalMaterialDigest("stocktake", { items })).not.toBe(approvalMaterialDigest("stocktake", { items: [...items].reverse() }));
});
