import {
  isCodedBrandName,
  normalizeDosageFormGroup,
  normalizeSchedule,
  scheduleFlags,
  splitBrandAndProductName,
  UNBRANDED_BRAND_LABEL,
} from "./seed-nmra";

describe("NMRA brand / schedule helpers", () => {
  it("splits strength from brand for product name (ALL CAPS)", () => {
    expect(splitBrandAndProductName("VERMOR SR 60")).toEqual({
      brandName: "VERMOR SR",
      productName: "VERMOR SR 60",
    });
    expect(splitBrandAndProductName("Panadol Extra 500mg")).toEqual({
      brandName: "PANADOL EXTRA",
      productName: "PANADOL EXTRA 500MG",
    });
    expect(splitBrandAndProductName("Vermor SR")).toEqual({
      brandName: "VERMOR SR",
      productName: "VERMOR SR",
    });
  });

  it("splits hyphenated trailing strength (e.g. VERMOR-30)", () => {
    expect(splitBrandAndProductName("VERMOR-30")).toEqual({
      brandName: "VERMOR",
      productName: "VERMOR 30",
    });
    expect(splitBrandAndProductName("A-GAB 75")).toEqual({
      brandName: "A-GAB",
      productName: "A-GAB 75",
    });
    expect(splitBrandAndProductName("PANADOL-500MG")).toEqual({
      brandName: "PANADOL",
      productName: "PANADOL 500MG",
    });
  });

  it("keeps unit-less single-digit brand suffixes (e.g. VERMOR 1)", () => {
    expect(splitBrandAndProductName("VERMOR 1")).toEqual({
      brandName: "VERMOR 1",
      productName: "VERMOR 1",
    });
    expect(splitBrandAndProductName("Brand X 2")).toEqual({
      brandName: "BRAND X 2",
      productName: "BRAND X 2",
    });
    // Explicit unit still splits even for single digits.
    expect(splitBrandAndProductName("VERMOR 1MG")).toEqual({
      brandName: "VERMOR",
      productName: "VERMOR 1MG",
    });
  });

  it("detects coded brand names", () => {
    expect(isCodedBrandName("10 D")).toBe(true);
    expect(isCodedBrandName("1000D")).toBe(true);
    expect(isCodedBrandName("20M")).toBe(true);
    expect(isCodedBrandName("45")).toBe(true);
    expect(isCodedBrandName("400 D")).toBe(true);
    expect(isCodedBrandName("5D")).toBe(true);
    expect(isCodedBrandName("A-SCABS")).toBe(false);
    expect(isCodedBrandName("VERMOR SR")).toBe(false);
    expect(isCodedBrandName("A-GAB 75")).toBe(false);
  });

  it("maps schedule selling rules", () => {
    expect(scheduleFlags("I", null, null)).toEqual({
      isControlled: false,
      requiresPrescription: false,
    });
    expect(scheduleFlags("II A", null, null)).toEqual({
      isControlled: false,
      requiresPrescription: false,
    });
    expect(scheduleFlags("II B", null, null)).toEqual({
      isControlled: false,
      requiresPrescription: true,
    });
    expect(scheduleFlags("II C", null, null)).toEqual({
      isControlled: true,
      requiresPrescription: true,
    });
    expect(scheduleFlags("III", null, null)).toEqual({
      isControlled: true,
      requiresPrescription: true,
    });
    expect(scheduleFlags("II A", "Morphine sulphate", null).isControlled).toBe(true);
  });

  it("normalizes schedule codes", () => {
    expect(normalizeSchedule("IIB")).toBe("II B");
    expect(normalizeSchedule("1")).toBe("I");
    expect(UNBRANDED_BRAND_LABEL).toBe("UNBRANDED");
  });
});

describe("normalizeDosageFormGroup", () => {
  it("groups plural TABLETS / CAPSULES (not Other)", () => {
    expect(normalizeDosageFormGroup("TABLETS", null)).toBe("Tablet");
    expect(normalizeDosageFormGroup("FILM COATED TABLETS", null)).toBe("Tablet");
    expect(normalizeDosageFormGroup("CAPSULES", null)).toBe("Capsule");
    expect(normalizeDosageFormGroup("HARD GELATIN CAPSULES", null)).toBe("Capsule");
    expect(normalizeDosageFormGroup("SOFT GELATIN CAPSULES", null)).toBe("Soft capsule");
    expect(normalizeDosageFormGroup("SYRUPS", null)).toBe("Syrup");
    expect(normalizeDosageFormGroup("INJECTIONS", null)).toBe("Injection");
    expect(normalizeDosageFormGroup("CREAMS", null)).toBe("Cream");
  });

  it("falls back to generic text when dosage is sparse", () => {
    expect(normalizeDosageFormGroup(null, "PARACETAMOL TABLETS 500 MG")).toBe("Tablet");
    expect(normalizeDosageFormGroup("SOLUTION", "AMOXICILLIN ORAL SUSPENSION")).toBe(
      "Suspension",
    );
  });
});
