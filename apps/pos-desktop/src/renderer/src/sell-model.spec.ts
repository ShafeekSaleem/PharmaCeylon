import { describe, expect, it } from "@jest/globals";
import type { CatalogProduct } from "../../shared/ipc-contract";
import {
  findProducts,
  highlight,
  isSlmcRefusal,
  issuedAgo,
  MAX_RESULTS,
  money,
  moveSelection,
  plainMoney,
  quickTenders,
  scannedProduct,
  slmcRefusal,
  stockText,
} from "./sell-model";

let n = 0;
const product = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  productId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  name: "Panadol 500mg Tablets",
  sku: null,
  barcode: null,
  strength: null,
  unit: "strip",
  unitPrice: "96.00",
  available: 40,
  needsPharmacist: false,
  requiresPrescription: false,
  isControlled: false,
  ...over,
});

describe("finding products", () => {
  const amox = product({
    name: "Amoxicillin 500mg Capsules",
    needsPharmacist: true,
    requiresPrescription: true,
    sku: "AMX500",
    barcode: "4791234567890",
  });
  const amoxOut = product({
    name: "Amoxicillin 250mg Dispersible",
    needsPharmacist: true,
    available: 0,
  });
  const panadol = product({ barcode: "4790000000017" });
  const catalog = [amox, amoxOut, panadol];

  it("matches a name anywhere, an SKU exactly and a barcode exactly, as checkout always has", () => {
    expect(findProducts(catalog, "moxi", "all")).toEqual([amox, amoxOut]);
    expect(findProducts(catalog, "amx500", "all")).toEqual([amox]);
    expect(findProducts(catalog, "amx", "all")).toEqual([]);
    expect(findProducts(catalog, "4790000000017", "all")).toEqual([panadol]);
    expect(findProducts(catalog, "  ", "all")).toEqual([]);
  });

  it("narrows by the find panel's chips", () => {
    expect(findProducts(catalog, "a", "stock")).toEqual([amox, panadol]);
    expect(findProducts(catalog, "a", "rx")).toEqual([amox, amoxOut]);
    expect(findProducts(catalog, "a", "otc")).toEqual([panadol]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_RESULTS + 5 }, () => product());
    expect(findProducts(many, "panadol", "all")).toHaveLength(MAX_RESULTS);
  });

  it("takes a scanned barcode whatever the chips show, and nothing for a partial code", () => {
    expect(scannedProduct(catalog, " 4791234567890 ")).toBe(amox);
    expect(scannedProduct(catalog, "479123")).toBeUndefined();
    expect(scannedProduct(catalog, "")).toBeUndefined();
  });

  it("highlights the first place the search appears", () => {
    expect(highlight("Co-amoxiclav 375mg", "AMOX")).toEqual({
      before: "Co-",
      hit: "amox",
      after: "iclav 375mg",
    });
    expect(highlight("Panadol", "amox")).toEqual({
      before: "Panadol",
      hit: "",
      after: "",
    });
  });

  it("says how much is left", () => {
    expect(stockText(340)).toEqual({ text: "340 in stock", tone: "ok" });
    expect(stockText(6)).toEqual({ text: "6 left", tone: "warn" });
    expect(stockText(0)).toEqual({ text: "Out of stock", tone: "none" });
  });

  it("moves the highlight round the list", () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe("money", () => {
  it("writes amounts the way the mockups do", () => {
    expect(money(271850)).toBe("2,718.50");
    expect(money(0)).toBe("0.00");
    expect(plainMoney(300000)).toBe("3000.00");
  });

  it("offers the next round notes above the total", () => {
    expect(quickTenders(271850)).toEqual([280000, 300000, 500000]);
    expect(quickTenders(9600)).toEqual([10000, 50000, 100000]);
    // An exact round total is offered as Exact; the notes start above it.
    expect(quickTenders(100000)).toEqual([110000, 150000, 200000]);
    expect(quickTenders(0)).toEqual([]);
  });
});

describe("prescription checks", () => {
  it("says how long ago it was issued", () => {
    expect(issuedAgo("2026-10-30", "2026-11-01")).toBe("Issued 2 days ago");
    expect(issuedAgo("2026-10-31", "2026-11-01")).toBe("Issued yesterday");
    expect(issuedAgo("2026-11-01", "2026-11-01")).toBe("Issued today");
  });
});

describe("SLMC refusals", () => {
  it("recognises the three codes and nothing else", () => {
    expect(isSlmcRefusal("SELLER_NOT_QUALIFIED")).toBe(true);
    expect(isSlmcRefusal("APPROVER_NOT_QUALIFIED")).toBe(true);
    expect(isSlmcRefusal("PHARMACIST_REQUIRED")).toBe(true);
    expect(isSlmcRefusal("CHECKOUT_UNCERTAIN")).toBe(false);
    expect(isSlmcRefusal("PRESCRIPTION_REQUIRED")).toBe(false);
  });

  it("names the co-signer, keeps the server's explanation and offers another pharmacist or a hold", () => {
    const refusal = slmcRefusal(
      "APPROVER_NOT_QUALIFIED",
      "Dilshan has no current SLMC registration at this branch.",
      "Dilshan Wickramasinghe",
    );
    expect(refusal.title).toBe(
      "Dilshan Wickramasinghe can't co-sign controlled medicines",
    );
    expect(refusal.detail).toBe(
      "Dilshan has no current SLMC registration at this branch.",
    );
    expect(refusal.actions).toEqual(["choose-pharmacist", "hold"]);
    expect(refusal.next).toMatch(/Nothing was charged/);
  });

  it("sends a seller without a registration to a pharmacist", () => {
    const refusal = slmcRefusal(
      "SELLER_NOT_QUALIFIED",
      "You have no current SLMC registration at this branch.",
    );
    expect(refusal.title).toBe("You can't dispense these medicines yourself");
    expect(refusal.actions).toEqual(["choose-pharmacist", "hold"]);
  });

  it("tells the counter to record a prescription with a registered pharmacist's PIN, or hold the sale", () => {
    const refusal = slmcRefusal(
      "PHARMACIST_REQUIRED",
      "Recording a prescription needs a pharmacist.",
    );
    expect(refusal.actions).toEqual(["choose-pharmacist", "hold"]);
    expect(refusal.next).toMatch(/ask for their PIN/);
    expect(refusal.next).not.toMatch(/isn't accepted/);
  });
});
