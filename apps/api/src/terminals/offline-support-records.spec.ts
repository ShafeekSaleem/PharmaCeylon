import { randomUUID } from "node:crypto";
import type { ExternalCardAttemptRecord, OfflineSaleIncident } from "@pharmaceylon/shared";
import { parseCardAttempt, parseSaleIncident } from "./offline-support-records.service";

const identity = () => ({
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: "key-1",
});
const incident = (overrides: Record<string, unknown> = {}): OfflineSaleIncident =>
  ({
    contractVersion: 1,
    kind: "sale_incident",
    recordId: randomUUID(),
    identity: identity(),
    saleCommandId: randomUUID(),
    recordedByUserId: randomUUID(),
    staffSignInId: randomUUID(),
    workSessionId: randomUUID(),
    recordedAt: 1_800_000_000_000,
    category: "quantity_error",
    description: "Handed over two units, three were entered",
    ...overrides,
  }) as OfflineSaleIncident;
const attempt = (overrides: Record<string, unknown> = {}): ExternalCardAttemptRecord =>
  ({
    contractVersion: 1,
    kind: "external_card_attempt",
    recordId: randomUUID(),
    identity: identity(),
    attemptId: randomUUID(),
    checkoutDraftId: randomUUID(),
    reviewedSaleDigest: "a".repeat(64),
    amountMinor: 125_000,
    staffSignInId: randomUUID(),
    workSessionId: randomUUID(),
    recordedAt: 1_800_000_000_000,
    state: "prepared",
    ...overrides,
  }) as ExternalCardAttemptRecord;
const code = (run: () => unknown) => {
  try {
    run();
    return "parsed";
  } catch (e) {
    return (e as { response?: { code?: string } }).response?.code ?? String(e);
  }
};

describe("parseSaleIncident", () => {
  it("accepts the shared incident shape", () => {
    const value = incident();
    expect(parseSaleIncident(value)).toBe(value);
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["another kind", { kind: "external_card_attempt" }],
    ["an unknown category", { category: "theft" }],
    ["an empty description", { description: "   " }],
    ["untrimmed text", { description: " Two units " }],
    ["an oversized description", { description: "x".repeat(1001) }],
    ["a card number in the description", { description: "Customer card 4111 1111 1111 1111 failed" }],
    ["a non-UUID sale", { saleCommandId: "sale-1" }],
    ["a coerced time", { recordedAt: "1800000000000" }],
  ])("refuses %s", (_name, overrides) => {
    expect(code(() => parseSaleIncident(incident(overrides)))).toBe("INVALID_COMMAND");
  });

  it("refuses a missing key", () => {
    const { description: _omitted, ...rest } = incident();
    expect(code(() => parseSaleIncident(rest))).toBe("INVALID_COMMAND");
  });
});

describe("parseCardAttempt", () => {
  const approved = { state: "approved", providerReference: "RRN 123456789012", approvalCode: "004512", approvedAt: 1_799_999_990_000 };
  it.each([
    ["prepared", {}],
    ["uncertain", { state: "uncertain" }],
    ["approved", approved],
    ["declined", { state: "declined", providerReference: "RRN 1", verifiedByUserId: randomUUID() }],
    ["linked_to_sale", { state: "linked_to_sale", providerReference: "RRN 1", saleCommandId: randomUUID() }],
  ])("accepts a %s event with exactly its own fields", (_state, overrides) => {
    const value = attempt(overrides);
    expect(parseCardAttempt(value)).toBe(value);
  });

  it.each([
    ["another state's field", { providerReference: "RRN 1" }],
    ["a missing state field", { state: "approved", providerReference: "RRN 1", approvalCode: "1" }],
    ["an unknown state", { state: "refunded" }],
    ["a zero amount", { amountMinor: 0 }],
    ["a fractional amount", { amountMinor: 10.5 }],
    ["a non-hex digest", { reviewedSaleDigest: "Z".repeat(64) }],
    ["approval after the event", { ...approved, approvedAt: 1_800_000_000_001 }],
    ["a card number as the reference", { ...approved, providerReference: "5500000000000004" }],
    ["an oversized reference", { ...approved, providerReference: "R".repeat(65) }],
    ["a non-UUID verifier", { state: "declined", providerReference: "RRN 1", verifiedByUserId: "manager" }],
  ])("refuses %s", (_name, overrides) => {
    expect(code(() => parseCardAttempt(attempt(overrides)))).toBe("INVALID_COMMAND");
  });
});
