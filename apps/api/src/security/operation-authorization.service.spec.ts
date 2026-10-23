import { randomUUID } from "node:crypto";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import type { RequestUser } from "./interfaces/authenticated-request.interface";
import {
  OperationAuthorizationService,
  type OperationDescriptor,
} from "./operation-authorization.service";
import { MandatoryOperationEvidence } from "./mandatory-operation-evidence";
import { object } from "../terminals/terminal-wire";

const user: RequestUser = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  tokenVersion: 0,
  authMethod: "bearer",
  branchRoles: [],
  fullName: "Owner",
  email: "owner@test.invalid",
};
const branchId = randomUUID();
const parseBody = (raw: unknown) =>
  object(raw, ["quantity"]) as { quantity: number };
const base: OperationDescriptor<{ quantity: number }> = {
  method: "POST",
  routeTemplate: "/api/v1/products",
  permission: "products.manage",
  parseBody,
};
const command = (): OnlineTerminalCommand<{ quantity: number }> => ({
  contractVersion: 1,
  kind: "online_operation",
  commandId: randomUUID(),
  identity: {
    tenantId: user.tenantId,
    branchId,
    terminalId: randomUUID(),
    enrollmentId: randomUUID(),
    keyId: randomUUID(),
  },
  session: {
    registerId: randomUUID(),
    tillId: randomUUID(),
    staffUserId: user.userId,
    workSessionId: randomUUID(),
  },
  operation: "POST /api/v1/sales/checkout",
  issuedAt: Date.now(),
  expiresAt: Date.now() + 120_000,
  serverNonce: "a".repeat(64),
  body: { quantity: 1 },
  approvalEvidenceId: null,
  pharmacistEvidenceId: null,
  operatingHoursExceptionId: null,
});
function fixture(evidence = new MandatoryOperationEvidence()) {
  const access = {
    resolveLive: jest.fn().mockResolvedValue({ has: () => true }),
  };
  const terminal = {
    command: command(),
    digest: "d".repeat(64),
    attendanceId: randomUUID(),
  };
  const terminals = { verifyCommand: jest.fn().mockResolvedValue(terminal) };
  const approvals = {
    requireForExecution: jest
      .fn()
      .mockResolvedValue({ approvalId: randomUUID() }),
  };
  const service = new OperationAuthorizationService(
    access as never,
    terminals as never,
    evidence,
    approvals as never,
  );
  return { service, access, terminals, approvals, terminal, evidence };
}
const localInput = {
  body: { quantity: 1 },
  signedCommand: { opaque: "verified by TerminalTrustService" },
  attendanceProofId: randomUUID(),
};
const stock = {
  ...base,
  routeTemplate: "/api/v1/inventory/adjustments",
  permission: "inventory.manage",
};

describe("Transactional operation authorization independently of owner permissions", () => {
  it.each([
    "/api/v1/products",
    "/api/v1/transfers",
    "/api/v1/purchasing/purchase-orders/:id/approve",
  ])(
    "permits remote management/reservations at %s without a terminal",
    async (routeTemplate) => {
      const f = fixture();
      const result = await f.service.authorize(
        {} as never,
        user,
        branchId,
        { ...base, routeTemplate },
        { body: { quantity: 1 } },
      );
      expect(result.terminal).toBeNull();
      expect(f.terminals.verifyCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/api/v1/inventory/adjustments",
    "/api/v1/sales/checkout",
    "/api/v1/transfers/:id/ship",
  ])(
    "owner cannot execute %s without terminal evidence",
    async (routeTemplate) => {
      const f = fixture();
      const descriptor = {
        ...base,
        routeTemplate,
        resolveFacts: async () => ({ clinicalSale: false, cashMovement: true }),
      };
      await expect(
        f.service.authorize({} as never, user, branchId, descriptor, {
          body: { quantity: 1 },
        }),
      ).rejects.toMatchObject({ response: { code: "TERMINAL_REQUIRED" } });
    },
  );

  it("requires the same signed body and mandatory hours evidence even for owner", async () => {
    const f = fixture();
    await expect(
      f.service.authorize({} as never, user, branchId, stock, localInput),
    ).rejects.toMatchObject({ response: { code: "TEMPORARILY_UNAVAILABLE" } });
    f.terminal.command.body.quantity = 2;
    await expect(
      f.service.authorize({} as never, user, branchId, stock, localInput),
    ).rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
  });

  it("clinical qualification is mandatory even with a terminal and every permission", async () => {
    const f = fixture();
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        {
          ...base,
          routeTemplate: "/api/v1/sales/checkout",
          resolveFacts: async () => ({
            clinicalSale: true,
            cashMovement: true,
          }),
        },
        localInput,
      ),
    ).rejects.toMatchObject({ response: { code: "PHARMACIST_REQUIRED" } });
  });

  it("re-resolves clinical facts after terminal lock waits", async () => {
    const f = fixture();
    let clinicalSale = false;
    f.terminals.verifyCommand.mockImplementation(async () => {
      clinicalSale = true;
      return f.terminal;
    });
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        {
          ...base,
          routeTemplate: "/api/v1/sales/checkout",
          resolveFacts: async () => ({ clinicalSale, cashMovement: true }),
        },
        localInput,
      ),
    ).rejects.toMatchObject({ response: { code: "PHARMACIST_REQUIRED" } });
  });

  it("bank records require independent evidence; cash cannot use the remote bank path", async () => {
    const f = fixture();
    const descriptor = {
      ...base,
      routeTemplate: "/api/v1/purchasing/payments",
      resolveFacts: async () => ({ paymentKind: "bank" as const }),
    };
    await expect(
      f.service.authorize({} as never, user, branchId, descriptor, {
        body: { quantity: 1 },
      }),
    ).rejects.toMatchObject({
      response: { code: "PAYMENT_EVIDENCE_REQUIRED" },
    });
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        { ...descriptor, resolveFacts: async () => ({ paymentKind: "cash" }) },
        { body: { quantity: 1 } },
      ),
    ).rejects.toMatchObject({ response: { code: "TERMINAL_REQUIRED" } });
  });

  it("rejects bank-to-cash fact changes during evidence verification", async () => {
    const evidence = new MandatoryOperationEvidence();
    let paymentKind: "bank" | "cash" = "bank";
    jest.spyOn(evidence, "bankPayment").mockImplementation(async () => {
      paymentKind = "cash";
    });
    const f = fixture(evidence);
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        {
          ...base,
          routeTemplate: "/api/v1/purchasing/payments",
          resolveFacts: async () => ({ paymentKind }),
        },
        { body: { quantity: 1 } },
      ),
    ).rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
  });

  it("binds the signed exact approval and permission and returns separate execution attribution inputs", async () => {
    const evidence = new MandatoryOperationEvidence();
    jest.spyOn(evidence, "hours").mockResolvedValue(undefined);
    const f = fixture(evidence);
    f.terminal.command = {
      ...f.terminal.command,
      approvalEvidenceId: randomUUID(),
    };
    const documentId = randomUUID();
    const descriptor = {
      ...base,
      routeTemplate: "/api/v1/transfers/:id/ship",
      permission: "transfers.manage",
      approval: {
        action: "transfer.ship" as const,
        documentId: () => documentId,
      },
    };
    const tx = {} as never;
    const result = await f.service.authorize(
      tx,
      user,
      branchId,
      descriptor,
      localInput,
    );
    expect(f.approvals.requireForExecution).toHaveBeenCalledWith(
      tx,
      user,
      branchId,
      "transfer.ship",
      documentId,
      f.terminal.command.approvalEvidenceId,
    );
    expect(f.terminals.verifyCommand).toHaveBeenCalledWith(
      tx,
      user,
      branchId,
      expect.objectContaining({
        operation: "POST /api/v1/transfers/:id/ship",
        permission: "transfers.manage",
      }),
      localInput.signedCommand,
      localInput.attendanceProofId,
    );
    expect(result.approval).not.toBeNull();
    expect(result.terminal?.command.session.staffUserId).toBe(user.userId);
  });

  it("requires bank evidence when cash becomes a bank record during the terminal wait", async () => {
    const f = fixture();
    let paymentKind: "bank" | "cash" = "cash";
    f.terminals.verifyCommand.mockImplementation(async () => {
      paymentKind = "bank";
      return f.terminal;
    });
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        {
          ...base,
          permission: "suppliers.pay",
          routeTemplate: "/api/v1/purchasing/payments",
          resolveFacts: async () => ({ paymentKind }),
        },
        localInput,
      ),
    ).rejects.toMatchObject({
      response: { code: "PAYMENT_EVIDENCE_REQUIRED" },
    });
  });

  it("permits a bank record remotely only after its evidence provider accepts the exact context", async () => {
    const evidence = new MandatoryOperationEvidence();
    const bank = jest
      .spyOn(evidence, "bankPayment")
      .mockResolvedValue(undefined);
    const f = fixture(evidence);
    const result = await f.service.authorize(
      {} as never,
      user,
      branchId,
      {
        ...base,
        permission: "suppliers.pay",
        routeTemplate: "/api/v1/purchasing/payments",
        resolveFacts: async () => ({ paymentKind: "bank" }),
      },
      { body: { quantity: 1 } },
    );
    expect(result.terminal).toBeNull();
    expect(bank).toHaveBeenCalledWith(expect.anything(), {
      tenantId: user.tenantId,
      branchId,
      actorUserId: user.userId,
      operation: "POST /api/v1/purchasing/payments",
      body: { quantity: 1 },
    });
  });

  it("checks mandatory hours after the approval document/evidence lock wait", async () => {
    const evidence = new MandatoryOperationEvidence();
    const f = fixture(evidence);
    let documentLocked = false;
    f.terminal.command = {
      ...f.terminal.command,
      approvalEvidenceId: randomUUID(),
    };
    f.approvals.requireForExecution.mockImplementation(async () => {
      documentLocked = true;
      return { approvalId: randomUUID() };
    });
    jest.spyOn(evidence, "hours").mockImplementation(async () => {
      expect(documentLocked).toBe(true);
    });
    await f.service.authorize(
      {} as never,
      user,
      branchId,
      {
        ...base,
        permission: "transfers.manage",
        routeTemplate: "/api/v1/transfers/:id/ship",
        approval: { action: "transfer.ship", documentId: () => randomUUID() },
      },
      localInput,
    );
  });

  it("denies missing/cross-action approvals, stripped DTO fields, unknown operations and missing live rights", async () => {
    const evidence = new MandatoryOperationEvidence();
    jest.spyOn(evidence, "hours").mockResolvedValue(undefined);
    const f = fixture(evidence);
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        {
          ...base,
          routeTemplate: "/api/v1/transfers/:id/ship",
          permission: "transfers.manage",
          approval: { action: "transfer.ship", documentId: () => randomUUID() },
        },
        localInput,
      ),
    ).rejects.toMatchObject({ response: { code: "APPROVAL_REQUIRED" } });
    f.terminal.command = {
      ...f.terminal.command,
      approvalEvidenceId: randomUUID(),
    };
    await expect(
      f.service.authorize({} as never, user, branchId, stock, localInput),
    ).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        { ...base, routeTemplate: "/api/v1/unknown" },
        { body: { quantity: 1 } },
      ),
    ).rejects.toThrow("Unclassified");
    await expect(
      f.service.authorize(
        {} as never,
        user,
        branchId,
        { ...base, parseBody: () => ({ quantity: 1 }) },
        { body: { quantity: 1, extra: true } },
      ),
    ).rejects.toThrow();
    f.access.resolveLive.mockResolvedValue({ has: () => false });
    await expect(
      f.service.authorize({} as never, user, branchId, base, {
        body: { quantity: 1 },
      }),
    ).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
  });
});
