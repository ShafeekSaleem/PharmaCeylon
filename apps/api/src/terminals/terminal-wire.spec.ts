import { randomUUID } from "node:crypto";
import {
  type OnlineTerminalCommand,
  terminalSigningText,
} from "@pharmaceylon/shared";
import { terminalDevice } from "../../test/fixtures/terminal-device";
import {
  boundedCanonical,
  object,
  parseOnlineCommand,
  times,
  verifySignature,
} from "./terminal-wire";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";

const device = terminalDevice();
const bodyParser = (raw: unknown) => {
  const body = object(raw, ["quantity"]);
  if (!Number.isSafeInteger(body.quantity) || (body.quantity as number) <= 0)
    throw new Error("Invalid quantity");
  return body as { quantity: number };
};
function payload(): OnlineTerminalCommand<{ quantity: number }> {
  return {
    contractVersion: 1,
    kind: "online_operation",
    commandId: randomUUID(),
    identity: {
      tenantId: randomUUID(),
      branchId: randomUUID(),
      terminalId: randomUUID(),
      enrollmentId: randomUUID(),
      keyId: randomUUID(),
    },
    session: {
      registerId: randomUUID(),
      tillId: randomUUID(),
      workSessionId: randomUUID(),
      staffUserId: randomUUID(),
    },
    operation: "POST /api/v1/sales/checkout",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 120_000,
    serverNonce: "a".repeat(64),
    body: { quantity: 1 },
    approvalEvidenceId: null,
    pharmacistEvidenceId: null,
    operatingHoursExceptionId: null,
  };
}
describe("Terminal wire boundary", () => {
  it("accepts a strictly parsed real Ed25519 signature and rejects a different key", () => {
    const p = payload();
    const envelope = device.sign(p, p.identity.keyId);
    expect(parseOnlineCommand(envelope, bodyParser)).toEqual(envelope);
    expect(() => verifySignature(envelope, device.publicKeyHex)).not.toThrow();
    expect(() =>
      verifySignature(envelope, terminalDevice().publicKeyHex),
    ).toThrow();
    expect(() =>
      verifySignature(
        { ...envelope, payload: { ...p, body: { quantity: 2 } } },
        device.publicKeyHex,
      ),
    ).toThrow();
  });

  it("rejects a signature from another protocol purpose", () => {
    const p = payload();
    const envelope = device.sign(p, p.identity.keyId);
    expect(terminalSigningText("grant", p)).not.toEqual(
      terminalSigningText("command", p),
    );
    expect(() =>
      verifySignature(
        device.sign(p, envelope.keyId, "grant"),
        device.publicKeyHex,
      ),
    ).toThrow();
  });

  it.each(["extra", "identity", "session", "body"])(
    "rejects unknown fields at %s",
    (field) => {
      const p = payload();
      const changed =
        field === "extra"
          ? { ...p, extra: true }
          : {
              ...p,
              [field]: { ...(p[field as "body"] as object), extra: true },
            };
      expect(() =>
        parseOnlineCommand(device.sign(changed, p.identity.keyId), bodyParser),
      ).toThrow();
    },
  );

  it("rejects envelope key injection, padded/noncanonical signatures and unknown algorithms", () => {
    const p = payload();
    const envelope = device.sign(p, p.identity.keyId);
    for (const changed of [
      { ...envelope, publicKeyHex: device.publicKeyHex },
      { ...envelope, signature: envelope.signature + "==" },
      { ...envelope, signature: envelope.signature.slice(0, 85) + "B" },
      { ...envelope, algorithm: "RSA" },
    ]) {
      expect(() => parseOnlineCommand(changed, bodyParser)).toThrow();
    }
  });

  it("rejects malformed IDs, numbers, discriminators and evidence references", () => {
    const p = payload();
    for (const changed of [
      { ...p, commandId: "" },
      { ...p, contractVersion: 2 },
      { ...p, kind: "offline_sale" },
      { ...p, issuedAt: 0.1 },
      { ...p, serverNonce: "nonce" },
      { ...p, pharmacistEvidenceId: "invalid" },
    ]) {
      expect(() =>
        parseOnlineCommand(device.sign(changed, p.identity.keyId), bodyParser),
      ).toThrow();
    }
  });

  it("rejects DTO stripping/coercion instead of changing signed values", () => {
    const p = payload();
    expect(() =>
      parseOnlineCommand(device.sign(p, p.identity.keyId), () => ({
        quantity: 2,
      })),
    ).toThrow();
    expect(() =>
      parseOnlineCommand(
        device.sign({ ...p, body: { quantity: "1" } }, p.identity.keyId),
        bodyParser,
      ),
    ).toThrow();
  });

  it("rejects excessive depth, size, getters, prototype objects and noncanonical JSON", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 18; i++) deep = { deep };
    const getter = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("Getter executed");
      },
    });
    for (const value of [
      deep,
      { text: "x".repeat(32_769) },
      getter,
      new Date(),
      { n: NaN },
      { n: -0 },
      { n: undefined },
      { items: Array.from({ length: 10_001 }, () => 1) },
      {
        a: "x".repeat(32_000),
        b: "x".repeat(32_000),
        c: "x".repeat(32_000),
        d: "x".repeat(32_000),
        e: "x".repeat(32_000),
      },
    ]) {
      expect(() => boundedCanonical(value)).toThrow();
    }
  });

  it("enforces trusted time and bounded challenge lifetime", () => {
    const now = Date.now();
    const p = payload();
    expect(() =>
      times({ ...p, issuedAt: now, expiresAt: now + 120_000 }, now),
    ).not.toThrow();
    for (const changed of [
      { ...p, issuedAt: now + 1 },
      { ...p, expiresAt: now },
      { ...p, issuedAt: now - 120_001, expiresAt: now + 1 },
    ])
      expect(() => times(changed, now)).toThrow();
  });

  it("production attendance verification denies a claim that was never recorded as a proof", async () => {
    await expect(
      new LocalAttendanceVerifier().verify(
        {} as never,
        "local=true",
        {} as never,
      ),
    ).rejects.toThrow();
  });
});
