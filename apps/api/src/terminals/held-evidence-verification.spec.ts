import { randomUUID } from "node:crypto";
import type { OfflineStaffSignIn } from "@pharmaceylon/shared";
import { cutoffPassed } from "./grant-cutoff";
import { coveredBy, parseOutage, parseStaffSignIn } from "./held-evidence-verification";

describe("held evidence verification helpers (P3 #49)", () => {
  it("covers a window only when the union of windows spans all of it", () => {
    const windows = [
      { startsAt: 100, endsAt: 200 },
      { startsAt: 0, endsAt: 50 },
      { startsAt: 200, endsAt: 300 },
    ];
    expect(coveredBy(windows, 120, 280)).toBe(true);
    expect(coveredBy(windows, 0, 50)).toBe(true);
    expect(coveredBy(windows, 40, 120)).toBe(false); // gap 50..100
    expect(coveredBy(windows, 250, 301)).toBe(false);
    expect(coveredBy([], 0, 1)).toBe(false);
  });

  it("parses the sign-in attestation and the outage with exact keys", () => {
    const signIn: OfflineStaffSignIn = {
      contractVersion: 1, kind: "offline_staff_sign_in", staffSignInId: randomUUID(),
      identity: { tenantId: randomUUID(), branchId: randomUUID(), terminalId: randomUUID(), enrollmentId: randomUUID(), keyId: "k" },
      session: { registerId: randomUUID(), tillId: randomUUID(), workSessionId: randomUUID(), staffUserId: randomUUID() },
      grantId: randomUUID(), grantVersion: 1, staffAuthorizationId: randomUUID(), credentialVersion: 1,
      method: "personal_pin", authenticatedAt: 1,
    };
    expect(parseStaffSignIn(signIn)).toBe(signIn);
    for (const bad of [
      { ...signIn, pin: "1234" },
      { ...signIn, method: "password" },
      { ...signIn, credentialVersion: 0 },
      { ...signIn, session: { ...signIn.session, staffUserId: "nobody" } },
    ])
      expect(() => parseStaffSignIn(bad)).toThrow();
    expect(parseOutage({ offlineSessionId: randomUUID(), offlineStartedAt: 5 })).toBeTruthy();
    expect(() => parseOutage({ offlineSessionId: randomUUID(), offlineStartedAt: -1 })).toThrow();
  });

  it("treats a grant as able to sell until the instant it expires", () => {
    const cutoff = { kind: "grants_expire", at: 1_000, lastGrantExpiresAt: 1_000 } as const;
    expect(cutoffPassed(cutoff, 999)).toBe(false);
    expect(cutoffPassed(cutoff, 1_000)).toBe(true);
    expect(cutoffPassed({ kind: "never_issued", at: null, lastGrantExpiresAt: null }, 0)).toBe(true);
  });
});
