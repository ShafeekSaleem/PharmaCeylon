import { parseStagedRows } from "./import-stock.service";

const row = {
  rowNumber: 1,
  productId: "11111111-1111-4111-8111-111111111111",
  name: "Panadol",
  categoryName: null,
  qty: 2,
  costPrice: 1.25,
  sellingPrice: 2,
  batchNo: "A",
  expiryDate: null,
};

it.each([
  { qty: "2" },
  { qty: 0 },
  { qty: 1.5 },
  { qty: Number.MAX_SAFE_INTEGER },
  { costPrice: -1 },
  { costPrice: 1.234 },
  { sellingPrice: Infinity },
  { rowNumber: 0 },
  { productId: "foreign-identity" },
  { expiryDate: "2027-02-30T00:00:00.000Z" },
  { postedBatchId: "forged-posting" },
  { unexpected: true },
])(
  "rejects malformed quantities, costs, dates and client posting claims: %o",
  (change) => {
    expect(() => parseStagedRows([{ ...row, ...change }])).toThrow();
  },
);
it("rejects duplicate product/batch stock rather than silently receiving it twice", () => {
  expect(() => parseStagedRows([row, { ...row, rowNumber: 2 }])).toThrow(
    /Duplicate/,
  );
});
it("accepts explicit empty replacement and optional expiry without inventing stock", () => {
  expect(parseStagedRows([])).toEqual([]);
  expect(parseStagedRows([row])).toEqual([row]);
});
