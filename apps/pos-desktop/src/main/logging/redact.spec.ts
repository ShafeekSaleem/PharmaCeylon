import { isSensitiveField, redact, redactText } from "./redact";

describe("isSensitiveField", () => {
  it.each(["password", "offlinePin", "pin_verifier", "accessToken", "Authorization", "dbKey", "device_private_key", "cvv", "key"])(
    "treats %s as a secret",
    (name) => expect(isSensitiveField(name)).toBe(true),
  );

  // Substring matching would hide these: "pin" in shipping, "pan" in company, "key" in idempotencyKey.
  it.each(["shipping", "company", "expanded", "idempotencyKey", "operationId", "unitsPerPack"])(
    "leaves %s alone",
    (name) => expect(isSensitiveField(name)).toBe(false),
  );
});

describe("redactText", () => {
  it("removes bearer tokens and JWTs", () => {
    expect(redactText("sent Authorization: Bearer abc.def-123")).toBe("sent Authorization: Bearer [REDACTED]");
    expect(redactText("got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl back")).toBe("got [REDACTED] back");
  });

  it("removes card numbers but keeps other long numbers", () => {
    expect(redactText("card 4111 1111 1111 1111 declined")).toBe("card [REDACTED] declined");
    expect(redactText("card 4111-1111-1111-1111 declined")).toBe("card [REDACTED] declined");
    // A 13-digit EAN barcode that fails the Luhn check is a product, not a card.
    expect(redactText("scanned 4791234567891")).toBe("scanned 4791234567891");
  });
});

describe("redact", () => {
  it("redacts by field name at any depth and keeps the rest", () => {
    expect(
      redact({
        userId: "u1",
        offlinePin: "1234",
        device: { id: "d1", privateKey: "-----BEGIN", nested: [{ token: "t", ok: true }] },
      }),
    ).toEqual({
      userId: "u1",
      offlinePin: "[REDACTED]",
      device: { id: "d1", privateKey: "[REDACTED]", nested: [{ token: "[REDACTED]", ok: true }] },
    });
  });

  it("reduces errors to name, code and a redacted message — no stack", () => {
    const error = Object.assign(new Error("failed with Bearer abc123"), { code: "E_SYNC" });
    expect(redact({ error })).toEqual({
      error: { name: "Error", message: "failed with Bearer [REDACTED]", code: "E_SYNC" },
    });
  });

  it("survives circular structures", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(redact(loop)).toEqual({ name: "loop", self: "[Circular]" });
  });
});
