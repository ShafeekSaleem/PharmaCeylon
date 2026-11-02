import { createIdempotencyKey, randomUuid } from "./idempotency";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid", () => {
  const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  afterEach(() => {
    if (original) Object.defineProperty(crypto, "randomUUID", original);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
  });

  it("builds a v4 UUID where randomUUID is missing (plain HTTP on a LAN)", () => {
    // An own property shadows the prototype's, the way an insecure context leaves it undefined.
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    expect(crypto.randomUUID).toBeUndefined();
    const ids = new Set(Array.from({ length: 20 }, () => randomUuid()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(V4);
    expect(createIdempotencyKey("scope", "resource")).toMatch(/^scope-resource-[0-9a-f-]{36}$/);
  });
});
