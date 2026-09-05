import {
  decideRangeExit,
  decideReferencePromotion,
} from "./range-transition.util";

const base = {
  productId: "p1",
  name: "Amlodipine 5mg Tablet",
  source: "NMRA",
  rangeStatus: "RANGED",
  nmraReferenceId: "ref-1",
  stockOnHand: 0,
  saleCount: 0,
  purchasingCount: 0,
};

describe("decideRangeExit", () => {
  it("sends a clean register-derived product back to the reference catalog", () => {
    const result = decideRangeExit(base);
    expect(result.action).toBe("unrange");
  });

  it("recognises a linked product as register-derived even when its source is local", () => {
    // A CSV-imported product that was later linked to a register row belongs to the register
    // as much as one that came from it — the link is the statement of provenance.
    const result = decideRangeExit({
      ...base,
      source: "CSV_IMPORT",
      nmraReferenceId: "ref-9",
    });
    expect(result.action).toBe("unrange");
  });

  /**
   * The bug this rule exists for: the Reference tab is supposed to answer "what is registered
   * in Sri Lanka". Unranging a locally created product filed it there, so the register started
   * containing whatever the shop had typed.
   */
  it.each(["MANUAL", "CSV_IMPORT", "SUPPLIER", "BARCODE"])(
    "deactivates a %s product instead of filing it into the register",
    (source) => {
      const result = decideRangeExit({
        ...base,
        source,
        nmraReferenceId: null,
      });
      expect(result.action).toBe("deactivate");
      expect(result.reason).toContain("local records don't belong in it");
    },
  );

  it("blocks anything still holding stock, whatever its provenance", () => {
    const result = decideRangeExit({ ...base, stockOnHand: 12 });
    expect(result.action).toBe("blocked");
    expect(result.reason).toContain("12 units on hand");
  });

  it("keeps a product with sales history in the range, deactivated", () => {
    expect(decideRangeExit({ ...base, saleCount: 1 }).action).toBe(
      "deactivate",
    );
  });

  it("keeps a product with purchasing history in the range, deactivated", () => {
    expect(decideRangeExit({ ...base, purchasingCount: 1 }).action).toBe(
      "deactivate",
    );
  });

  it("blocks a product that is not ranged in the first place", () => {
    const result = decideRangeExit({ ...base, rangeStatus: "REFERENCE" });
    expect(result.action).toBe("blocked");
    expect(result.reason).toContain("not in your range");
  });

  it("always says why", () => {
    for (const input of [
      base,
      { ...base, stockOnHand: 3 },
      { ...base, source: "MANUAL", nmraReferenceId: null },
    ]) {
      expect(decideRangeExit(input).reason.length).toBeGreaterThan(20);
    }
  });
});

describe("decideReferencePromotion", () => {
  const reference = {
    referenceProductId: "ref-1",
    name: "STAMLO 5",
    rangeStatus: "REFERENCE",
    source: "NMRA",
    claimedByProductId: null,
    duplicateCandidates: [],
    complianceChange: false,
  };

  it("allows a clean promotion without review", () => {
    const result = decideReferencePromotion(reference);
    expect(result).toMatchObject({
      allowed: true,
      needsReview: false,
      warnings: [],
    });
  });

  it("refuses a row already in the range", () => {
    const result = decideReferencePromotion({
      ...reference,
      rangeStatus: "RANGED",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("already in your products");
  });

  it("refuses a row another product has already claimed", () => {
    const result = decideReferencePromotion({
      ...reference,
      claimedByProductId: "p9",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("already linked");
  });

  it("refuses anything that is not an NMRA register entry", () => {
    expect(
      decideReferencePromotion({ ...reference, source: "MANUAL" }).allowed,
    ).toBe(false);
  });

  /**
   * Allowed but flagged, not blocked: a second pack size legitimately shares a registration
   * number, so this is a decision rather than an error. What must not happen is it being made
   * silently — that is how one medicine ends up with its stock split across two records.
   */
  it("flags a barcode duplicate for review without blocking it", () => {
    const result = decideReferencePromotion({
      ...reference,
      duplicateCandidates: [
        { id: "p2", name: "Amlodipine 5mg", matchedOn: "barcode" },
      ],
    });
    expect(result.allowed).toBe(true);
    expect(result.needsReview).toBe(true);
    expect(result.warnings[0]).toContain("same barcode");
  });

  it("flags a registration-number duplicate", () => {
    const result = decideReferencePromotion({
      ...reference,
      duplicateCandidates: [
        { id: "p2", name: "Amlodipine 5mg", matchedOn: "registrationNo" },
      ],
    });
    expect(result.warnings[0]).toContain("same registration number");
  });

  it("flags a compliance difference against the product it would merge with", () => {
    const result = decideReferencePromotion({
      ...reference,
      complianceChange: true,
    });
    expect(result.needsReview).toBe(true);
    expect(result.warnings[0]).toContain("controlled or prescription-only");
  });
});
