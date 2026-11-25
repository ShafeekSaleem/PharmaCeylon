import { offlineCommandOccurredAt, effectiveSaleInstant } from "./sales-report-effective-time";

describe("sales-report-effective-time", () => {
  it("reads occurredAt from a signed offline ordinary_sale command", () => {
    const occurredAt = Date.parse("2026-06-01T10:00:00.000Z");
    expect(
      offlineCommandOccurredAt({
        payload: { kind: "ordinary_sale", occurredAt },
      }),
    ).toBe(occurredAt);
  });

  it("prefers journal occurredAt over soldAt for offline sales", () => {
    const commandId = "cmd-1";
    const map = new Map([[commandId, Date.parse("2026-06-01T10:00:00.000Z")]]);
    const at = effectiveSaleInstant(
      { offlineCommandId: commandId, soldAt: new Date("2026-06-02T10:00:00.000Z") },
      map,
    );
    expect(at.toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });
});