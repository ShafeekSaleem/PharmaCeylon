import { classifyNmraEligibility } from "./nmra-eligibility";

/**
 * The register-match queue is only usable if it contains medicines. A pharmacy's range is
 * roughly half general retail, and the old rule ("everything ranged that didn't come from
 * NMRA") put all of it in the queue — so these tests are mostly about what must stay *out*.
 */
describe("classifyNmraEligibility", () => {
  describe("clearly not a medicine", () => {
    const retail = [
      "Umbrella — Folding 21in",
      "Digital Kitchen Scale",
      "Pampers Diapers Medium 42s",
      "Sunsilk Shampoo 180ml",
      "Axe Deodorant Spray 150ml",
      "Anchor Full Cream Milk Powder 400g",
      "Assorted Confectionery Pack",
      "AA Batteries 4 Pack",
    ];

    it.each(retail)("excludes %s", (name) => {
      const result = classifyNmraEligibility({ name });
      expect(result.verdict).toBe("not_applicable");
      expect(result.reason).toContain("general retail stock");
    });

    /**
     * The trap this exists to catch: "150ml" and "400g" are dosed strengths by the regex, and
     * "Cream" is a dosage form. Reading the retail keyword first is what stops half the shelf
     * being classified as medicine on a units suffix.
     */
    it("is not fooled by a units suffix on a toiletry", () => {
      expect(
        classifyNmraEligibility({ name: "Axe Deodorant Spray 150ml" }).verdict,
      ).toBe("not_applicable");
      expect(
        classifyNmraEligibility({ name: "Anchor Full Cream Milk Powder 400g" })
          .verdict,
      ).toBe("not_applicable");
    });
  });

  describe("regulatory signals win outright", () => {
    it("keeps a product that already carries a registration number", () => {
      const result = classifyNmraEligibility({
        name: "Mystery Item",
        registrationNo: "M016695",
      });
      expect(result.verdict).toBe("eligible");
      expect(result.signals).toContain("registration_no");
    });

    it("keeps a controlled product even when its name reads like retail", () => {
      // A regulatory flag someone has already set outranks any keyword guess.
      const result = classifyNmraEligibility({
        name: "Cough Candy",
        isControlled: true,
      });
      expect(result.verdict).toBe("eligible");
    });

    it("keeps a prescription-only product", () => {
      expect(
        classifyNmraEligibility({
          name: "Something",
          requiresPrescription: true,
        }).verdict,
      ).toBe("eligible");
    });

    it("keeps a product filed under a medicines category", () => {
      expect(
        classifyNmraEligibility({
          name: "Unnamed",
          commercialCanonicalKey: "MEDICINES_CARDIOVASCULAR",
        }).verdict,
      ).toBe("eligible");
    });

    it("reads a real NMRA schedule but ignores free text in the schedule field", () => {
      expect(
        classifyNmraEligibility({ name: "X", schedule: "IIB" }).verdict,
      ).toBe("eligible");
      expect(
        classifyNmraEligibility({ name: "X", schedule: "not applicable" })
          .verdict,
      ).toBe("uncertain");
    });
  });

  describe("weak medicine signals", () => {
    it("keeps a dosed tablet", () => {
      const result = classifyNmraEligibility({
        name: "Cetirizine 10mg Tablet",
        dosageForm: "Tablet",
        strength: "10mg",
      });
      expect(result.verdict).toBe("eligible");
      expect(result.signals.some((s) => s.startsWith("dosage_form:"))).toBe(
        true,
      );
    });

    it("keeps anything with a generic/substance name", () => {
      expect(
        classifyNmraEligibility({ name: "Norvasc", genericName: "Amlodipine" })
          .verdict,
      ).toBe("eligible");
    });

    it("reads a dosage form out of the name when the column is empty", () => {
      expect(classifyNmraEligibility({ name: "Panadol Tablets" }).verdict).toBe(
        "eligible",
      );
    });

    it("does not fire on a word that merely contains a form abbreviation", () => {
      // "tab" inside "Table" and "gel" inside "Gelatin Sheets" must not read as a dosage form.
      expect(classifyNmraEligibility({ name: "Folding Table" }).verdict).toBe(
        "uncertain",
      );
    });
  });

  describe("uncertain", () => {
    it("neither queues nor excludes something with no signal either way", () => {
      const result = classifyNmraEligibility({ name: "Blue Box" });
      expect(result.verdict).toBe("uncertain");
      expect(result.signals).toEqual([]);
    });
  });

  /**
   * The tier decides one thing: whether a product that matched *nothing* in the register still
   * earns a queue entry saying so. Running the classifier over a real seeded catalog is what
   * surfaced this — "Hand Sanitizer Gel 100ml", "Body Lotion 400ml" and "Wheat Baby Cereal
   * 400g" were all being queued as unmatched medicines, because "gel"/"lotion" are dosage forms
   * and "100ml"/"400g" are dosed strengths.
   */
  describe("evidence tier", () => {
    it.each([
      ["a registration number", { name: "X", registrationNo: "M016695" }],
      ["a schedule", { name: "X", schedule: "IIB" }],
      ["a controlled flag", { name: "X", isControlled: true }],
      ["a prescription flag", { name: "X", requiresPrescription: true }],
    ])("calls %s a regulatory signal", (_label, input) => {
      expect(classifyNmraEligibility(input).tier).toBe("regulatory");
    });

    it.each([
      ["a dosage form", { name: "Cetirizine Tablet" }],
      ["a generic name", { name: "Norvasc", genericName: "Amlodipine" }],
      ["a dosed strength", { name: "Mystery 500mg" }],
    ])("calls %s a weak signal", (_label, input) => {
      const result = classifyNmraEligibility(input);
      expect(result.verdict).toBe("eligible");
      expect(result.tier).toBe("weak");
    });

    it.each(["Hand Sanitizer Gel 100ml", "Wheat Baby Cereal 400g"])(
      "does not treat %s as a regulatory signal",
      (name) => {
        expect(classifyNmraEligibility({ name }).tier).not.toBe("regulatory");
      },
    );

    it("gives nothing at all the none tier", () => {
      expect(classifyNmraEligibility({ name: "Blue Box" }).tier).toBe("none");
      expect(classifyNmraEligibility({ name: "Umbrella" }).tier).toBe("none");
    });
  });

  /** A nebuliser is a device; the medicine is the solution that goes in it. */
  it("does not read a nebuliser machine as a dosage form", () => {
    expect(
      classifyNmraEligibility({ name: "Compressor Nebulizer" }).verdict,
    ).toBe("uncertain");
  });

  it("still keeps the solution that goes in one", () => {
    expect(
      classifyNmraEligibility({
        name: "Salbutamol Respirator Solution",
        genericName: "Salbutamol",
      }).verdict,
    ).toBe("eligible");
  });

  it("always explains itself — an exclusion nobody can account for is a bug report", () => {
    for (const name of ["Umbrella", "Cetirizine 10mg Tablet", "Blue Box"]) {
      expect(classifyNmraEligibility({ name }).reason.length).toBeGreaterThan(
        20,
      );
    }
  });
});
