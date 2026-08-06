import { nameSimilarity, softRxMatchWarnings } from "./rx-match.util";

describe("rx-match.util", () => {
  it("scores matching names highly despite order", () => {
    expect(nameSimilarity("Kamal Silva", "Silva Kamal")).toBeGreaterThan(0.9);
  });

  it("warns on weak patient/customer name match", () => {
    const warnings = softRxMatchWarnings({
      patientName: "Anjali Fernando",
      customerName: "Walk-in Guest",
    });
    expect(warnings.some((w) => w.code === "patient_name_mismatch")).toBe(true);
  });

  it("does not warn when names share tokens", () => {
    const warnings = softRxMatchWarnings({
      patientName: "Kamal A. Silva",
      customerName: "Kamal Silva",
    });
    expect(warnings).toHaveLength(0);
  });
});
