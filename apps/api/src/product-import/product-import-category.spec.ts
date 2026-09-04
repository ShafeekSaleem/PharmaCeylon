import {
  buildCategoryPlan,
  CommercialCategoryIndex,
  normalizeCategoryName,
  resolveCategoryAssignments,
  type CommercialCategoryRow,
} from "./product-import-category";

/** A cut-down stand-in for the seeded commercial template. */
const ROWS: CommercialCategoryRow[] = [
  { id: "med", name: "Medicines", parentCategoryId: null, canonicalKey: "MEDICINES", isActive: true },
  {
    id: "pain",
    name: "Pain & Fever",
    parentCategoryId: "med",
    canonicalKey: "MEDICINES_PAIN_FEVER",
    isActive: true,
  },
  {
    id: "unclassified",
    name: "Unclassified Medicines",
    parentCategoryId: "med",
    canonicalKey: "MEDICINES_UNCLASSIFIED",
    isActive: true,
  },
  {
    id: "pc",
    name: "Personal Care",
    parentCategoryId: null,
    canonicalKey: "PERSONAL_CARE",
    isActive: false,
  },
  {
    id: "oral",
    name: "Oral Care",
    parentCategoryId: "pc",
    canonicalKey: "PERSONAL_CARE_ORAL_CARE",
    isActive: false,
  },
  {
    id: "vits",
    name: "Vitamins & Supplements",
    parentCategoryId: null,
    canonicalKey: "VITAMINS_SUPPLEMENTS",
    isActive: true,
  },
  // Deliberate name clash with its own department, to pin the child-wins rule.
  {
    id: "vits-child",
    name: "Vitamins",
    parentCategoryId: "vits",
    canonicalKey: "VITAMINS_SUPPLEMENTS_VITAMINS",
    isActive: true,
  },
];

const index = new CommercialCategoryIndex(ROWS);

describe("normalizeCategoryName", () => {
  it("folds case, punctuation and the two ways of writing an ampersand", () => {
    const expected = "pain and fever";
    expect(normalizeCategoryName("Pain & Fever")).toBe(expected);
    expect(normalizeCategoryName("pain and fever")).toBe(expected);
    expect(normalizeCategoryName("  PAIN  &  FEVER  ")).toBe(expected);
    expect(normalizeCategoryName("Pain-and-Fever")).toBe(expected);
  });

  it("returns an empty key for values with nothing to match on", () => {
    expect(normalizeCategoryName("   ")).toBe("");
    expect(normalizeCategoryName("---")).toBe("");
  });
});

describe("CommercialCategoryIndex", () => {
  it("matches a category by name regardless of how it was typed", () => {
    expect(index.resolve("Pain & Fever")?.row.id).toBe("pain");
    expect(index.resolve("pain and fever")?.row.id).toBe("pain");
    expect(index.resolve("PERSONAL CARE")?.row.id).toBe("pc");
  });

  it("prefers the child over a department sharing its name", () => {
    // "Vitamins" is both a department stem and a child; the child is the more specific answer.
    const hit = index.resolve("Vitamins");
    expect(hit?.row.id).toBe("vits-child");
    expect(hit?.via).toBe("name");
  });

  it("falls back to the legacy-name synonym table", () => {
    const hit = index.resolve("Painkillers");
    expect(hit?.row.id).toBe("pain");
    expect(hit?.via).toBe("synonym");
  });

  it("resolves synonyms through canonicalKey, not display name", () => {
    // A tenant that renamed the category still gets the synonym.
    const renamed = new CommercialCategoryIndex(
      ROWS.map((r) => (r.id === "pain" ? { ...r, name: "Aches & Temperature" } : r)),
    );
    expect(renamed.resolve("analgesics")?.row.id).toBe("pain");
  });

  it("returns null rather than guessing at an unknown name", () => {
    expect(index.resolve("Ayurvedic Preparations")).toBeNull();
    expect(index.resolve("")).toBeNull();
  });

  it("renders a department › category path", () => {
    expect(index.path(ROWS[1])).toBe("Medicines › Pain & Fever");
    expect(index.path(ROWS[0])).toBe("Medicines");
  });
});

describe("buildCategoryPlan", () => {
  it("groups distinct values, counts rows and separates the blanks", () => {
    const plan = buildCategoryPlan(
      index,
      ["Pain & Fever", "pain and fever", "Personal Care", null, "  ", "Ayurvedic"],
      true,
    );

    expect(plan.blankRows).toBe(2);
    expect(plan.entries).toHaveLength(3);

    const pain = plan.entries.find((e) => e.categoryId === "pain");
    expect(pain?.rowCount).toBe(2);
    expect(pain?.status).toBe("matched");
    expect(pain?.categoryPath).toBe("Medicines › Pain & Fever");
  });

  it("lists the values needing a decision first", () => {
    const plan = buildCategoryPlan(
      index,
      ["Pain & Fever", "Pain & Fever", "Pain & Fever", "Ayurvedic"],
      true,
    );
    // Unmatched comes first even though it is the rarer value — it is the only one to act on.
    expect(plan.entries[0].incoming).toBe("Ayurvedic");
    expect(plan.entries[0].status).toBe("unmatched");
    expect(plan.entries[1].incoming).toBe("Pain & Fever");
  });

  it("flags a match onto a category the tenant currently has switched off", () => {
    const plan = buildCategoryPlan(index, ["Oral Care"], true);
    expect(plan.entries[0].categoryId).toBe("oral");
    expect(plan.entries[0].willEnable).toBe(true);
  });

  it("does not flag an already-enabled category", () => {
    const plan = buildCategoryPlan(index, ["Pain & Fever"], true);
    expect(plan.entries[0].willEnable).toBe(false);
  });
});

describe("resolveCategoryAssignments", () => {
  const plan = buildCategoryPlan(index, ["Pain & Fever", "Ayurvedic", "Oral Care"], true);

  it("applies every automatic match when the user changed nothing", () => {
    const assignments = resolveCategoryAssignments(plan, {});
    expect(assignments.get("pain and fever")).toBe("pain");
    expect(assignments.get("oral care")).toBe("oral");
    // Unmatched stays unmatched — it falls through to the classifier, not to a guess.
    expect(assignments.has("ayurvedic")).toBe(false);
  });

  it("lets an explicit choice override an automatic match", () => {
    const assignments = resolveCategoryAssignments(plan, {
      "Pain & Fever": { action: "use", categoryId: "vits-child" },
    });
    expect(assignments.get("pain and fever")).toBe("vits-child");
  });

  it("places a value the resolver could not match", () => {
    const assignments = resolveCategoryAssignments(plan, {
      Ayurvedic: { action: "use", categoryId: "med" },
    });
    expect(assignments.get("ayurvedic")).toBe("med");
  });

  it("drops a value the user chose to skip", () => {
    const assignments = resolveCategoryAssignments(plan, {
      "Pain & Fever": { action: "skip" },
    });
    expect(assignments.has("pain and fever")).toBe(false);
  });

  it("ignores a choice keyed to a value not in this file", () => {
    const assignments = resolveCategoryAssignments(plan, {
      "Not In The File": { action: "use", categoryId: "med" },
    });
    expect(assignments.has("not in the file")).toBe(false);
  });
});
