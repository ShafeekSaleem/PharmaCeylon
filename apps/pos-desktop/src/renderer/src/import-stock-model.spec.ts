import { describe, expect, it } from "@jest/globals";
import type { CounterWorkImportDetail } from "@pharmaceylon/shared";
import { buildImportPost, categoryKey, categoryLabel, joinNames, pickCategory, restOf } from "./import-stock-model";

const detail = {
  id: "00000000-0000-4000-8000-000000000077",
  stockVersion: 3,
  categories: [
    { categoryName: "Analgesics", rows: 84, batches: 84, units: 3420, posted: true },
    { categoryName: "Antibiotics", rows: 61, batches: 63, units: 2850, posted: false },
    { categoryName: null, rows: 5, batches: 5, units: 40, posted: false },
  ],
  rows: [],
} as unknown as CounterWorkImportDetail;

describe("opening stock", () => {
  it("names the rows with no category, and keeps them apart from any name", () => {
    expect(categoryLabel(null)).toBe("No category");
    expect(categoryKey(null)).not.toBe(categoryKey("No category"));
  });

  it("sums what the rest posts, leaving out what is posted", () => {
    const rest = restOf(detail);
    expect(rest).toMatchObject({ rows: 66, batches: 68, units: 2890 });
    expect(rest.posted.map((c) => c.categoryName)).toEqual(["Analgesics"]);
    expect(joinNames(rest.categories)).toBe("Antibiotics and No category");
  });

  it("shows the chosen category, else the first still to post", () => {
    expect(pickCategory(detail, null)?.categoryName).toBe("Antibiotics");
    expect(pickCategory(detail, categoryKey(null))?.categoryName).toBeNull();
    // A posted category can be chosen to look at; one that is gone falls back.
    expect(pickCategory(detail, categoryKey("Analgesics"))?.categoryName).toBe("Analgesics");
    expect(pickCategory(detail, categoryKey("Vitamins"))?.categoryName).toBe("Antibiotics");
  });

  it("pins the body to the version shown", () => {
    expect(buildImportPost(detail, { selection: "all" })).toEqual({
      importId: detail.id, version: 3, selection: "all", categoryName: null,
    });
    expect(buildImportPost(detail, { selection: "category", categoryName: null })).toEqual({
      importId: detail.id, version: 3, selection: "category", categoryName: null,
    });
  });
});
