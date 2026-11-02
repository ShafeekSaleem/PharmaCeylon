import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import type { Logger } from "../logging/logger";
import { DispensingService } from "../checkout/dispensing";
import { CounterWorkService } from "./counter-work";
import { SignedCommandService } from "./signed-commands";
import type { TerminalService } from "./terminal-service";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  flush: async () => {},
};
const key = DeviceKey.generate();
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: key.keyId,
};
const staff = {
  workSessionId: randomUUID(),
  staffUserId: randomUUID(),
  staffName: "Cashier",
  openedAt: "",
};
const refundRequestId = randomUUID();
const approvalId = randomUUID();

let dir: string;
let local: LocalStore;
let sent: { path: string; body: any }[];
let executeReply: () => unknown;
let tamper = false;

function services() {
  const api = {
    request: async (_m: string, path: string, opts: { body?: any } = {}) => {
      sent.push({ path, body: opts.body });
      if (path === "/sales/refund-requests")
        return [
          {
            id: refundRequestId,
            requestNumber: "RR-7",
            invoiceNo: "INV-1",
            amount: "120.00",
            refundMethod: "cash",
            reason: "Wrong item",
            executionApprovalId: approvalId,
            readyAtCounter: true,
            requester: { id: "a", fullName: "Remote Manager" },
            approver: { id: "b", fullName: "Owner" },
            approvalRequired: true,
          },
        ];
      if (path === "/terminal-commands/prepare")
        return {
          contractVersion: 1,
          kind: "online_operation",
          commandId: randomUUID(),
          identity,
          session: {
            registerId: randomUUID(),
            tillId: randomUUID(),
            workSessionId: staff.workSessionId,
            staffUserId: staff.staffUserId,
          },
          operation: opts.body.operation,
          issuedAt: 1,
          expiresAt: 2,
          serverNonce: "e".repeat(64),
          body: tamper ? { refundRequestId: randomUUID() } : opts.body.body,
          approvalEvidenceId: opts.body.approvalEvidenceId,
          pharmacistEvidenceId: null,
          operatingHoursExceptionId: null,
        };
      if (path === "/terminal-commands/execute") {
        const stored = local.db
          .prepare("SELECT status FROM signed_command")
          .get();
        expect(stored).toEqual({
          status: expect.stringMatching(/sent|uncertain/),
        });
        return executeReply();
      }
      throw new Error(path);
    },
  };
  const terminal = {
    current: () => ({ staff, identity, key }),
    attendCommand: async () => ({
      proofId: randomUUID(),
      purpose: "command",
      expiresAt: 0,
    }),
  };
  const commands = new SignedCommandService({
    db: local.db,
    api: api as unknown as ApiSession,
    terminal: terminal as unknown as TerminalService,
    logger,
  });
  return {
    commands,
    work: new CounterWorkService({
      api: api as unknown as ApiSession,
      terminal: terminal as unknown as TerminalService,
      commands,
    }),
    dispensing: new DispensingService({
      api: api as unknown as ApiSession,
      terminal: terminal as unknown as TerminalService,
      commands,
      now: () => new Date("2026-11-03T08:00:00.000Z"),
    }),
  };
}

const receipt = (replayed = false) => ({
  contractVersion: 1,
  kind: "online_command_receipt",
  receiptId: randomUUID(),
  replayed,
  result: {
    type: "sale_refund.executed",
    refundRequestId,
    approvalId,
    goodsReturnId: randomUUID(),
    amountMinor: 12000,
    refundedTo: [{ method: "cash", amountMinor: 12000 }],
    effect: "applied",
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-signed-spec-"));
  local = openLocalStore(dir, protector, migrations);
  sent = [];
  tamper = false;
  executeReply = () => receipt();
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("signed counter commands", () => {
  it("executes a remotely approved refund with its approval evidence and reports who did what", async () => {
    const { work } = services();
    const [ready] = await work.refundsReady();
    expect(ready).toMatchObject({
      requestedBy: "Remote Manager",
      approvedBy: "Owner",
      approvalEvidenceId: approvalId,
    });
    const done = await work.executeRefund(refundRequestId);
    expect(done).toMatchObject({
      amountMinor: 12000,
      alreadyApplied: false,
      approvedBy: "Owner",
    });
    const prepare = sent.find((s) => s.path === "/terminal-commands/prepare")!;
    expect(prepare.body).toMatchObject({
      approvalEvidenceId: approvalId,
      workSessionId: staff.workSessionId,
    });
    const execute = sent.find((s) => s.path === "/terminal-commands/execute")!;
    expect(execute.body.command.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it("refuses to sign a command the server changed", async () => {
    tamper = true;
    const { work } = services();
    await expect(work.executeRefund(refundRequestId)).rejects.toMatchObject({
      code: "CHALLENGE_INVALID",
    });
    expect(sent.some((s) => s.path === "/terminal-commands/execute")).toBe(
      false,
    );
  });

  it("resends the identical signed envelope after a lost response", async () => {
    const { work, commands } = services();
    executeReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(work.executeRefund(refundRequestId)).rejects.toMatchObject({
      code: "COMMAND_UNCERTAIN",
    });
    const [pending] = commands.pending();
    executeReply = () => receipt(true);
    await expect(commands.retry(pending!.commandId)).resolves.toMatchObject({
      replayed: true,
    });
    const executes = sent.filter(
      (s) => s.path === "/terminal-commands/execute",
    );
    expect(executes[1]!.body).toEqual(executes[0]!.body);
    expect(commands.pending()).toEqual([]);
  });

  it("keeps a resent command pending when it is refused before the server could find the original", async () => {
    const { work, commands } = services();
    executeReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(work.executeRefund(refundRequestId)).rejects.toMatchObject({
      code: "COMMAND_UNCERTAIN",
    });
    const [pending] = commands.pending();
    executeReply = () => {
      throw new ApiError(401, "NOT_SIGNED_IN", "Sign in first.");
    };
    await expect(commands.retry(pending!.commandId)).rejects.toBeInstanceOf(ApiError);
    expect(commands.pending()).toHaveLength(1);
  });
});

describe("prescriptions recorded at the counter", () => {
  const prescriptionId = randomUUID();
  const pharmacistRegistrationId = randomUUID();
  const input = {
    patientName: "Nimal Perera",
    doctorName: "Silva",
    issuedOn: "2026-11-02",
    notes: "Repeat x2",
  };
  const status = () =>
    local.db.prepare("SELECT operation, status, error_code FROM signed_command").all();

  it("sends a signed clinical command, with no approval or co-sign evidence, and keeps its receipt", async () => {
    const { dispensing } = services();
    executeReply = () => ({
      ...receipt(),
      operation: "POST /api/v1/prescriptions",
      result: { type: "prescription.recorded", prescriptionId, rxNumber: "RX-00040", pharmacistRegistrationId },
    });
    await expect(dispensing.record(input)).resolves.toMatchObject({
      prescriptionId,
      rxNumber: "RX-00040",
      patientName: "Nimal Perera",
      validUntil: null,
      expired: false,
    });
    const prepare = sent.find((s) => s.path === "/terminal-commands/prepare")!;
    expect(prepare.body).toEqual({
      workSessionId: staff.workSessionId,
      operation: "POST /api/v1/prescriptions",
      body: {
        rxNumber: null,
        patientName: "Nimal Perera",
        doctorName: "Silva",
        doctorRegNo: null,
        issuedOn: "2026-11-02",
        validUntil: null,
        customerId: null,
        notes: "Repeat x2",
      },
      approvalEvidenceId: null,
      pharmacistEvidenceId: null,
      operatingHoursExceptionId: null,
    });
    const execute = sent.find((s) => s.path === "/terminal-commands/execute")!;
    expect(execute.body.command.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(sent.some((s) => s.path === "/prescriptions")).toBe(false);
    expect(status()).toEqual([
      { operation: "POST /api/v1/prescriptions", status: "receipted", error_code: null },
    ]);
  });

  it("treats a missing SLMC registration as a final refusal the counter can explain", async () => {
    const { dispensing, commands } = services();
    executeReply = () => {
      throw new ApiError(403, "PHARMACIST_REQUIRED", "Terminal authorization failed");
    };
    await expect(dispensing.record(input)).rejects.toMatchObject({
      code: "PHARMACIST_REQUIRED",
      message: expect.stringContaining("switch in at this counter"),
    });
    expect(commands.pending()).toEqual([]);
    expect(status()).toEqual([
      { operation: "POST /api/v1/prescriptions", status: "refused", error_code: "PHARMACIST_REQUIRED" },
    ]);
  });

  it("keeps an unanswered one to confirm, and says the prescription may exist", async () => {
    const { dispensing, commands } = services();
    executeReply = () => {
      throw new ApiError(0, "NETWORK", "lost");
    };
    await expect(dispensing.record(input)).rejects.toMatchObject({
      code: "COMMAND_UNCERTAIN",
      message: expect.stringContaining("may have been saved"),
    });
    expect(commands.pending()).toMatchObject([{ operation: "POST /api/v1/prescriptions" }]);
  });
});
