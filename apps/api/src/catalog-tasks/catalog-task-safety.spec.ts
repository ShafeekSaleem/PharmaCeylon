import { classifyTaskSafety, SAFE_CATEGORY_CONFIDENCE } from "./catalog-task-safety";

/**
 * "Apply safe changes" is one click over an unbounded number of products, so the definition of
 * safe is the load-bearing part of the whole Work Queue. The old button ("Accept all top
 * matches") had no definition at all — it took whatever ranked first, compliance flags
 * included. Each test below pins one condition that must hold.
 */
describe("classifyTaskSafety", () => {
  const exactNmraMatch = {
    type: "NMRA_MATCH" as const,
    evidence: "registration",
    confidence: 0.98,
    complianceImpact: false,
    identifierAmbiguous: false,
    candidateCount: 1,
    alreadyLinked: false,
    referenceClaimed: false,
  };

  it("accepts a unique exact-identifier match that changes no compliance flag", () => {
    const result = classifyTaskSafety(exactNmraMatch);
    expect(result.safeToApply).toBe(true);
    expect(result.status).toBe("OPEN");
    expect(result.blockers).toEqual([]);
  });

  it.each(["barcode", "registration", "name"])(
    "treats %s as an exact identifier",
    (evidence) => {
      expect(classifyTaskSafety({ ...exactNmraMatch, evidence }).safeToApply).toBe(true);
    },
  );

  it.each(["normalized", "fuzzy", "inn_head"])(
    "refuses %s — a resemblance is not an identification",
    (evidence) => {
      const result = classifyTaskSafety({ ...exactNmraMatch, evidence });
      expect(result.safeToApply).toBe(false);
      expect(result.blockers.join(" ")).toContain("resemblance");
    },
  );

  /**
   * The specific failure this prevents: applying forty matches in one click, three of which
   * quietly make a product prescription-only (blocking legitimate sales) or stop it being
   * controlled (letting a restricted sale through).
   */
  it("never applies a compliance change in bulk, however strong the evidence", () => {
    const result = classifyTaskSafety({
      ...exactNmraMatch,
      evidence: "barcode",
      complianceImpact: true,
    });
    expect(result.safeToApply).toBe(false);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.blockers.join(" ")).toContain("compliance flag");
  });

  it("routes an ambiguous identifier to review rather than picking one", () => {
    const result = classifyTaskSafety({ ...exactNmraMatch, identifierAmbiguous: true });
    expect(result.safeToApply).toBe(false);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.blockers.join(" ")).toContain("more than one register entry");
  });

  it("refuses when more than one candidate survived", () => {
    expect(classifyTaskSafety({ ...exactNmraMatch, candidateCount: 3 }).safeToApply).toBe(false);
  });

  it("refuses when there is no candidate at all", () => {
    const result = classifyTaskSafety({ ...exactNmraMatch, candidateCount: 0, evidence: null });
    expect(result.safeToApply).toBe(false);
    expect(result.blockers.join(" ")).toContain("No candidate found");
  });

  it("refuses to re-link a product that already carries a link", () => {
    expect(classifyTaskSafety({ ...exactNmraMatch, alreadyLinked: true }).safeToApply).toBe(false);
  });

  it("refuses a register entry another product has already claimed", () => {
    expect(classifyTaskSafety({ ...exactNmraMatch, referenceClaimed: true }).safeToApply).toBe(
      false,
    );
  });

  it("always refuses an NMRA_AMBIGUOUS task, whatever else it carries", () => {
    const result = classifyTaskSafety({
      ...exactNmraMatch,
      type: "NMRA_AMBIGUOUS",
      identifierAmbiguous: false,
    });
    expect(result.safeToApply).toBe(false);
    expect(result.status).toBe("NEEDS_REVIEW");
  });

  it("always sends an import duplicate to review", () => {
    const result = classifyTaskSafety({ ...exactNmraMatch, type: "IMPORT_DUPLICATE" });
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.safeToApply).toBe(false);
  });

  describe("category tasks", () => {
    const categoryTask = {
      type: "MISSING_CATEGORY" as const,
      evidence: "generic_rule",
      confidence: 0.85,
      complianceImpact: false,
      identifierAmbiguous: false,
      candidateCount: 1,
      alreadyLinked: false,
      referenceClaimed: false,
    };

    it("applies a confident suggestion", () => {
      expect(classifyTaskSafety(categoryTask).safeToApply).toBe(true);
    });

    it(`holds anything below ${SAFE_CATEGORY_CONFIDENCE}`, () => {
      const result = classifyTaskSafety({ ...categoryTask, confidence: 0.6 });
      expect(result.safeToApply).toBe(false);
      expect(result.blockers.join(" ")).toContain("60%");
      // A weak suggestion is ordinary work, not something needing individual review.
      expect(result.status).toBe("OPEN");
    });

    it("holds a task with no suggestion, but leaves it OPEN for a human to file", () => {
      const result = classifyTaskSafety({
        ...categoryTask,
        evidence: null,
        confidence: null,
        candidateCount: 0,
      });
      expect(result.safeToApply).toBe(false);
      expect(result.status).toBe("OPEN");
      expect(result.blockers.join(" ")).toContain("No category could be suggested");
    });
  });
});
