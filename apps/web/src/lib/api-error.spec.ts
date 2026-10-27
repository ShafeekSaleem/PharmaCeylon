import {
  ApiError,
  COUNTER_BOUNDARY_MESSAGES,
  counterBoundaryMessage,
  parseApiError,
  parseApiErrorBody,
} from "./api-error";

describe("counter-boundary refusals", () => {
  const copy: Array<[string, string]> = [
    [
      "TERMINAL_REQUIRED",
      "This is done at the counter. Open PharmaCeylon POS at the branch to finish it.",
    ],
    ["REMOTE_SESSION_DENIED", "This needs someone at the counter in person."],
    ["APPROVAL_REQUIRED", "This needs approval first."],
    ["APPROVAL_INVALID", "This approval doesn't match the document. Ask for a new approval."],
    ["APPROVAL_STALE", "This changed after it was approved. It needs fresh approval."],
    ["SELF_APPROVAL_DENIED", "You raised this, so someone else needs to approve it."],
    ["PAYMENT_EVIDENCE_REQUIRED", "Attach the payment evidence to record this payment."],
    ["PHARMACIST_REQUIRED", "A pharmacist has to verify this at the counter."],
  ];

  it.each(copy)("shows %s as the target doc's message", (code, message) => {
    const body = JSON.stringify({ code, message: "Terminal authorization failed", statusCode: 403 });
    expect(parseApiError(body, "fallback")).toBe(message);
    expect(counterBoundaryMessage(code)).toBe(message);
  });

  it("covers exactly the eight codes in the copy table", () => {
    expect(Object.keys(COUNTER_BOUNDARY_MESSAGES).sort()).toEqual(copy.map(([code]) => code).sort());
  });

  it("carries the mapped message on the ApiError a page catches", () => {
    const text = JSON.stringify({ code: "APPROVAL_STALE", message: "Terminal authorization failed" });
    const error = new ApiError(parseApiError(text, "Request failed"), 403, parseApiErrorBody(text));
    expect(error.message).toBe(COUNTER_BOUNDARY_MESSAGES.APPROVAL_STALE);
    expect(error.code).toBe("APPROVAL_STALE");
  });

  it("leaves other coded refusals and plain messages alone", () => {
    expect(
      parseApiError(JSON.stringify({ code: "COST_CONFLICT", message: "batch already in stock" }), "x"),
    ).toBe("Batch already in stock");
    expect(parseApiError(JSON.stringify({ message: ["name is required"] }), "x")).toBe(
      "Name is required.",
    );
    expect(counterBoundaryMessage("toString")).toBeNull();
    expect(counterBoundaryMessage(undefined)).toBeNull();
  });
});
