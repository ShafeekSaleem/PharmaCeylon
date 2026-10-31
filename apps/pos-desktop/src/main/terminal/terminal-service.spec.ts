import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  terminalSigningText,
  type LocalAttendanceAttestation,
  type Signed,
  type TerminalEnrollmentCommand,
  type TerminalSessionCommand,
  type WindowsSessionEvidence,
} from "@pharmaceylon/shared";
import { ApiError, type ApiSession, type AuthUser } from "../api/api-client";
import { buildAttestation, challengeDigest } from "../attendance/attestation";
import { classifyWindowsSession } from "../attendance/windows-session";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { DeviceStore } from "../device/device-store";
import { openLocalStore, type LocalStore } from "../local-store";
import type { Logger } from "../logging/logger";
import { PinStore } from "../staff/pin-store";
import { TerminalService } from "./terminal-service";

const fakeProtector: SecretProtector = {
  isAvailable: () => true,
  protect: (plain) => Buffer.from(plain.split("").reverse().join(""), "utf8"),
  unprotect: (blob) => blob.toString("utf8").split("").reverse().join(""),
};
const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, flush: async () => {} };
const CONSOLE: WindowsSessionEvidence = { sessionId: 1, protocol: "console", remoteSession: false };

const tenantId = randomUUID();
const branchId = randomUUID();
const registerId = randomUUID();
const tillId = randomUUID();
const manager: AuthUser = {
  id: randomUUID(),
  tenantId,
  email: "manager@example.test",
  fullName: "Manager",
  roles: ["manager"],
  branchRoles: [{ branchId, role: "manager" }],
};
const cashier: AuthUser = { ...manager, id: randomUUID(), email: "cashier@example.test", fullName: "Cashier", roles: ["cashier"] };

function verifies(envelope: Signed<unknown>, publicKeyHex: string, purpose: "command" | "attendance") {
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(terminalSigningText(purpose, envelope.payload)), key, Buffer.from(envelope.signature, "base64url"));
}

/** A server that checks what a real one would: signatures, digests and bindings. */
class FakeServer {
  user: AuthUser | null = null;
  enrollmentStatus: "active" | "revoked" = "active";
  failFinishEnrollment: ApiError | null = null;
  pin: string | null = null;
  pinVersion = 0;
  preparedVersion: number | null = null;
  enrolledKey: string | null = null;
  readonly proofs = new Map<string, LocalAttendanceAttestation>();
  readonly calls: string[] = [];
  private challenge: TerminalEnrollmentCommand | TerminalSessionCommand | null = null;
  private occupied = false;

  readonly api = {
    get user() {
      return server.user;
    },
    login: async (email: string) => {
      this.user = email === cashier.email ? cashier : manager;
      return this.user;
    },
    logout: async () => {
      this.user = null;
    },
    request: async (method: string, path: string, opts: { body?: any; branchId?: string } = {}) => {
      this.calls.push(`${method} ${path}`);
      return this.handle(method, path, opts.body);
    },
  };

  private handle(method: string, path: string, body: any): unknown {
    const now = Date.now();
    if (path === "/tenant/context")
      return { branchRoles: [{ branchId, branch: { id: branchId, code: "MAIN", name: "Main" } }] };
    if (path === "/terminals/counters")
      return [
        {
          registerId,
          tillId,
          label: "Counter 1",
          isActive: true,
          terminal: this.occupied ? { terminalId: randomUUID(), label: "Other", enrollmentId: null, enrolledAt: null } : null,
        },
      ];
    if (path === "/terminals/enrollments/code-challenge") {
      if (body.code !== "ABCDE-12345") throw new ApiError(403, "ENROLLMENT_CODE_INVALID", "x");
      const command = this.handle(method, "/terminals/enrollments/challenge", { ...body, registerId }) as TerminalEnrollmentCommand;
      return { command, counterLabel: "Code counter" };
    }
    if (path === "/terminals/enrollments/challenge") {
      this.challenge = {
        contractVersion: 1,
        kind: "terminal_enrollment",
        identity: { tenantId, branchId, terminalId: randomUUID(), enrollmentId: randomUUID(), keyId: body.keyId },
        requestedByUserId: this.user!.id,
        registerId,
        tillId,
        label: body.label,
        publicKeyHex: body.publicKeyHex,
        issuedAt: now,
        expiresAt: now + 120_000,
        serverNonce: "a".repeat(64),
      };
      return this.challenge;
    }
    if (path === "/terminals/attendance-proofs") {
      const envelope = body as Signed<LocalAttendanceAttestation>;
      const a = envelope.payload;
      const key = this.challenge!.kind === "terminal_enrollment" ? this.challenge!.publicKeyHex : this.enrolledKey!;
      if (!verifies(envelope, key, "attendance")) throw new ApiError(403, "INVALID_SIGNATURE", "bad signature");
      if (a.payloadDigest !== challengeDigest(this.challenge)) throw new ApiError(403, "CHALLENGE_INVALID", "digest");
      if (a.actorUserId !== this.user!.id) throw new ApiError(403, "IDENTITY_MISMATCH", "actor");
      this.proofs.set(a.proofId, a);
      return { proofId: a.proofId, purpose: a.purpose, expiresAt: now + 60_000 };
    }
    if (path === "/terminals/enrollments") {
      const challenge = this.challenge as TerminalEnrollmentCommand;
      if (!verifies(body.envelope, challenge.publicKeyHex, "command")) throw new ApiError(403, "INVALID_SIGNATURE", "x");
      if (this.proofs.get(body.attendanceProofId)?.purpose !== "enrollment")
        throw new ApiError(403, "LOCAL_ATTENDANCE_UNAVAILABLE", "x");
      if (this.failFinishEnrollment && !this.failFinishEnrollment.uncertain) throw this.failFinishEnrollment;
      this.enrolledKey = challenge.publicKeyHex;
      this.occupied = true;
      // An uncertain failure is a lost response: the server did enroll the device.
      if (this.failFinishEnrollment) throw this.failFinishEnrollment;
      return challenge.identity;
    }
    if (path.startsWith("/terminals/enrollments/"))
      return { enrollmentId: path.split("/").pop(), terminalId: randomUUID(), registerId, tillId, label: "PC", status: this.enrollmentStatus };
    if (path === "/terminals/sessions/challenge") {
      this.challenge = {
        contractVersion: 1,
        kind: "terminal_session",
        identity: body.identity,
        session: { workSessionId: randomUUID(), staffUserId: this.user!.id, registerId, tillId },
        tokenVersion: 0,
        issuedAt: now,
        expiresAt: now + 120_000,
        serverNonce: "b".repeat(64),
      };
      return this.challenge;
    }
    if (path === "/terminals/sessions") {
      const challenge = this.challenge as TerminalSessionCommand;
      if (!verifies(body.envelope, this.enrolledKey!, "command")) throw new ApiError(403, "INVALID_SIGNATURE", "x");
      if (this.proofs.get(body.attendanceProofId)?.purpose !== "session")
        throw new ApiError(403, "LOCAL_ATTENDANCE_UNAVAILABLE", "x");
      return challenge.session;
    }
    if (path.endsWith("/end")) return undefined;
    const credential = () => ({
      pinSet: this.pin !== null,
      pinVersion: this.pinVersion,
      lockedUntil: null,
      preparedVersion: this.preparedVersion,
    });
    if (path.endsWith("/credential")) return credential();
    if (path.endsWith("/pin")) {
      if (body.password !== "password") throw new ApiError(401, "PASSWORD_INCORRECT", "x");
      this.pin = body.pin;
      this.pinVersion += 1;
      this.preparedVersion = this.pinVersion;
      return credential();
    }
    if (path.endsWith("/prepare")) {
      if (body.pin !== this.pin) throw new ApiError(401, "PIN_INCORRECT", "x");
      this.preparedVersion = this.pinVersion;
      return credential();
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }
}

let server: FakeServer;
let dir: string;
let local: LocalStore;
let windowsSession: WindowsSessionEvidence;

function service() {
  return new TerminalService({
    store: new DeviceStore(local.db),
    pins: new PinStore(local.db),
    api: server.api as unknown as ApiSession,
    serverUrl: () => "https://pos.example.test/api/v1",
    serverUrlEditable: true,
    readWindowsSession: () => windowsSession,
    appVersion: "0.0.1",
    logger,
  });
}

async function enrolled(terminal = service()) {
  await terminal.signIn(manager.email, "password");
  return terminal.enroll({ branchId, registerId, label: "Front desk PC" });
}

beforeEach(() => {
  server = new FakeServer();
  windowsSession = CONSOLE;
  dir = mkdtempSync(join(tmpdir(), "pos-terminal-spec-"));
  local = openLocalStore(dir, fakeProtector, migrations);
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("TerminalService enrollment", () => {
  it("enrolls with a fresh key, proves attendance and signs the manager out", async () => {
    const state = await enrolled();
    expect(state.enrollment).toMatchObject({ status: "active", branchName: "Main", counterLabel: "Counter 1" });
    expect(state.operator).toBeNull();
    const key = new DeviceStore(local.db).key()!;
    expect(key.publicKeyHex).toBe(server.enrolledKey);
    // Nothing secret leaks into what the renderer receives.
    expect(JSON.stringify(state)).not.toContain(server.enrolledKey);
  });

  it("refuses to enroll from a remote session before contacting the server for a proof", async () => {
    const terminal = service();
    await terminal.signIn(manager.email, "password");
    windowsSession = { sessionId: 2, protocol: "rdp", remoteSession: true };
    await expect(terminal.enroll({ branchId, registerId, label: "PC" })).rejects.toMatchObject({
      code: "REMOTE_SESSION_DENIED",
    });
    expect(server.calls).not.toContain("POST /terminals/attendance-proofs");
    expect(new DeviceStore(local.db).read()).toBeNull();
  });

  it("discards the saved key when the server definitely refused, keeps it when the outcome is unknown", async () => {
    server.failFinishEnrollment = new ApiError(403, "PERMISSION_DENIED", "no");
    const terminal = service();
    await terminal.signIn(manager.email, "password");
    await expect(terminal.enroll({ branchId, registerId, label: "PC" })).rejects.toBeInstanceOf(ApiError);
    expect(new DeviceStore(local.db).read()).toBeNull();

    server.failFinishEnrollment = new ApiError(0, "NETWORK", "offline");
    await expect(terminal.enroll({ branchId, registerId, label: "PC" })).rejects.toBeInstanceOf(ApiError);
    expect(new DeviceStore(local.db).read()?.status).toBe("pending");

    // The next sign-in asks the server, which did accept it, and promotes the pending enrollment.
    server.failFinishEnrollment = null;
    await terminal.signIn(cashier.email, "password");
    expect(new DeviceStore(local.db).read()?.status).toBe("active");
  });

  it("will not enroll onto a counter another computer occupies", async () => {
    await enrolled();
    const other = mkdtempSync(join(tmpdir(), "pos-terminal-spec-"));
    const second = openLocalStore(other, fakeProtector, migrations);
    try {
      const terminal = new TerminalService({
        store: new DeviceStore(second.db),
        pins: new PinStore(second.db),
        api: server.api as unknown as ApiSession,
        serverUrl: () => "https://pos.example.test/api/v1",
        serverUrlEditable: true,
        readWindowsSession: () => windowsSession,
        appVersion: "0.0.1",
        logger,
      });
      await terminal.signIn(manager.email, "password");
      await expect(terminal.enroll({ branchId, registerId, label: "PC 2" })).rejects.toMatchObject({
        code: "COUNTER_OCCUPIED",
      });
    } finally {
      second.db.close();
      rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("TerminalService staff sessions", () => {
  it("opens a session for the person who signs in and logs it locally", async () => {
    const terminal = service();
    await enrolled(terminal);
    const state = await terminal.signIn(cashier.email, "password");
    expect(state.staffSession).toMatchObject({ staffUserId: cashier.id, staffName: "Cashier" });
    expect(new DeviceStore(local.db).openSession()?.staffUserId).toBe(cashier.id);

    const after = await terminal.signOut();
    expect(after.staffSession).toBeNull();
    expect(new DeviceStore(local.db).openSession()).toBeNull();
    expect(server.calls.some((c) => c.endsWith("/end"))).toBe(true);
  });

  it("switching user closes the previous person's session first", async () => {
    const terminal = service();
    await enrolled(terminal);
    const first = (await terminal.signIn(cashier.email, "password")).staffSession!;
    const second = (await terminal.signIn(manager.email, "password")).staffSession!;
    expect(second.workSessionId).not.toBe(first.workSessionId);
    expect(new DeviceStore(local.db).openSession()?.workSessionId).toBe(second.workSessionId);
  });

  it("refuses to open a session once the back office has revoked the counter", async () => {
    const terminal = service();
    await enrolled(terminal);
    server.enrollmentStatus = "revoked";
    await expect(terminal.signIn(cashier.email, "password")).rejects.toMatchObject({ code: "TERMINAL_REVOKED" });
    expect(terminal.state().enrollment?.status).toBe("revoked");
    expect(terminal.state().operator).toBeNull();
  });
});

describe("attendance building blocks", () => {
  it("binds the attestation to the challenge digest the server computes", () => {
    const key = DeviceKey.generate();
    const challenge: TerminalSessionCommand = {
      contractVersion: 1,
      kind: "terminal_session",
      identity: { tenantId, branchId, terminalId: randomUUID(), enrollmentId: randomUUID(), keyId: key.keyId },
      session: { workSessionId: randomUUID(), staffUserId: cashier.id, registerId, tillId },
      tokenVersion: 3,
      issuedAt: 1,
      expiresAt: 2,
      serverNonce: "c".repeat(64),
    };
    const attestation = buildAttestation({
      challenge,
      purpose: "session",
      actorUserId: cashier.id,
      windowsSession: CONSOLE,
      appVersion: "1.2.3",
      now: 5,
    });
    const expected = createHash("sha256").update(terminalSigningText("command", challenge)).digest("hex");
    expect(attestation).toMatchObject({ payloadDigest: expected, registerId, tillId, identity: challenge.identity });
    expect(verifies(key.sign(attestation, "attendance"), key.publicKeyHex, "attendance")).toBe(true);
    expect(verifies(key.sign(attestation, "attendance"), key.publicKeyHex, "command")).toBe(false);
  });

  it("restores a stored key only when it matches its pinned public key", () => {
    const key = DeviceKey.generate();
    expect(DeviceKey.fromStored(key.keyId, key.exportPkcs8(), key.publicKeyHex).publicKeyHex).toBe(key.publicKeyHex);
    expect(() => DeviceKey.fromStored(key.keyId, key.exportPkcs8(), DeviceKey.generate().publicKeyHex)).toThrow();
  });

  it.each([
    [null, "unknown", false],
    [{ processSessionId: 1, activeConsoleSessionId: 1, remoteSessionMetric: false, clientProtocol: 0 }, "console", false],
    [{ processSessionId: 2, activeConsoleSessionId: 1, remoteSessionMetric: true, clientProtocol: 2 }, "rdp", true],
    [{ processSessionId: 1, activeConsoleSessionId: 1, remoteSessionMetric: true, clientProtocol: 0 }, "unknown", true],
    [{ processSessionId: 2, activeConsoleSessionId: 1, remoteSessionMetric: false, clientProtocol: 0 }, "unknown", false],
    [{ processSessionId: 1, activeConsoleSessionId: 0xffffffff, remoteSessionMetric: false, clientProtocol: 0 }, "unknown", false],
    [{ processSessionId: 1, activeConsoleSessionId: 1, remoteSessionMetric: false, clientProtocol: null }, "unknown", false],
  ] as const)("classifies Windows session facts %j as %s", (facts, protocol, remote) => {
    const result = classifyWindowsSession(facts);
    expect(result.protocol).toBe(protocol);
    expect(result.remoteSession).toBe(remote);
  });
});

describe("TerminalService PINs and locking", () => {
  it("sets a PIN here, keeps a local verifier and unlocks only with that PIN", async () => {
    const terminal = service();
    await enrolled(terminal);
    let state = await terminal.signIn(cashier.email, "password");
    expect(state.pin).toEqual({ set: false, prepared: false, lockedUntil: null });
    expect(() => terminal.lock()).toThrow(/Prepare your PIN/);

    state = await terminal.setPin("4821", "password");
    expect(state.pin).toMatchObject({ set: true, prepared: true });
    state = terminal.lock();
    expect(state.locked).toBe(true);
    expect(terminal.current()).toBeNull();
    await expect(terminal.setPin("1111", "password")).rejects.toMatchObject({ code: "LOCKED" });

    expect(() => terminal.unlock("0000")).toThrow(expect.objectContaining({ code: "PIN_INCORRECT" }));
    expect(terminal.unlock("4821").locked).toBe(false);
    // The verifier is a scrypt hash, never the PIN.
    const row = local.db.prepare("SELECT verifier FROM staff_credential").get() as { verifier: Buffer };
    expect(row.verifier.includes(Buffer.from("4821"))).toBe(false);
  });

  it("locks the local PIN after five wrong attempts, across restarts", async () => {
    const terminal = service();
    await enrolled(terminal);
    await terminal.signIn(cashier.email, "password");
    await terminal.setPin("4821", "password");
    terminal.lock();
    for (let i = 0; i < 4; i++) expect(() => terminal.unlock("0000")).toThrow(expect.objectContaining({ code: "PIN_INCORRECT" }));
    expect(() => terminal.unlock("0000")).toThrow(expect.objectContaining({ code: "PIN_LOCKED" }));
    // A fresh service (app restart) reads the same persisted lockout.
    expect(new PinStore(local.db).check(cashier.id, terminal.state().enrollment!.enrollmentId, "4821", new Date())).toBe("locked");
  });

  it("prepares a counter for a PIN set elsewhere and drops a verifier made stale by a change", async () => {
    server.pin = "2468";
    server.pinVersion = 3;
    server.preparedVersion = null;
    const terminal = service();
    await enrolled(terminal);
    let state = await terminal.signIn(cashier.email, "password");
    expect(state.pin).toMatchObject({ set: true, prepared: false });
    await expect(terminal.preparePin("1357")).rejects.toMatchObject({ code: "PIN_INCORRECT" });
    state = await terminal.preparePin("2468");
    expect(state.pin?.prepared).toBe(true);

    // Changed on another counter: version 4. Signing in here again forgets the old verifier.
    server.pin = "9753";
    server.pinVersion = 4;
    await terminal.signOut();
    state = await terminal.signIn(cashier.email, "password");
    expect(state.pin).toMatchObject({ set: true, prepared: false });
    expect(local.db.prepare("SELECT count(*) AS n FROM staff_credential").get()).toEqual({ n: 0 });
  });
});

describe("TerminalService enrollment codes", () => {
  it("lets a cashier enroll with a manager's code", async () => {
    const terminal = service();
    await terminal.signIn(cashier.email, "password");
    await expect(terminal.enrollWithCode({ branchId, code: "WRONG-CODE0", label: "PC" })).rejects.toMatchObject({
      code: "ENROLLMENT_CODE_INVALID",
    });
    const state = await terminal.enrollWithCode({ branchId, code: "ABCDE-12345", label: "PC" });
    expect(state.enrollment).toMatchObject({ status: "active", counterLabel: "Code counter" });
    expect(new DeviceStore(local.db).read()?.enrolledByUserId).toBe(cashier.id);
  });
});
