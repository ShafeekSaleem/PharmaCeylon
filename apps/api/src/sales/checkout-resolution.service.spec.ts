import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CHECKOUT_SEALED_SCOPE } from "./checkout-lock";
import { CheckoutResolutionService } from "./checkout-resolution.service";

const tenantId = "00000000-0000-4000-8000-0000000000a1";
const branchId = "00000000-0000-4000-8000-0000000000b1";
const enrollmentId = "00000000-0000-4000-8000-0000000000c1";
const sellerId = "00000000-0000-4000-8000-0000000000d1";
const originalSession = "00000000-0000-4000-8000-0000000000e1";
const callerSession = "00000000-0000-4000-8000-0000000000e2";
const key = "00000000-0000-4000-8000-0000000000f1";
const manager: RequestUser = {
  userId: "00000000-0000-4000-8000-0000000000d2",
  tenantId,
  tokenVersion: 0,
  email: "m@example.test",
  fullName: "Manager",
  authMethod: "bearer",
  branchRoles: [],
};

function setup(state: { committed?: string; sealed?: boolean; saleSession?: string; callerEnrollment?: string } = {}) {
  const order: string[] = [];
  const tx = {
    terminalStaffSession: {
      findFirst: jest.fn(async () => {
        order.push("original");
        return { id: originalSession, staffUserId: sellerId, enrollmentId };
      }),
    },
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push(`lock:${String(values[0])}`);
      return 1;
    }),
    idempotencyRecord: {
      findUnique: jest.fn(async (args: { where: { tenantId_userId_scope_idempotencyKey: { scope: string } } }) => {
        const scope = args.where.tenantId_userId_scope_idempotencyKey.scope;
        if (scope === "checkout") return state.committed ? { resourceId: state.committed } : null;
        return state.sealed ? { resourceId: callerSession } : null;
      }),
      create: jest.fn(async () => {
        order.push("seal");
        return {};
      }),
    },
    sale: {
      findFirst: jest.fn(async (args: { where: { workSessionId: string } }) =>
        args.where.workSessionId === (state.saleSession ?? originalSession) ? { id: state.committed } : null,
      ),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    sale: { findFirst: jest.fn(async () => ({ id: state.committed, seller: { fullName: "Seller" } })) },
  };
  const trust = {
    requireOpenSession: jest.fn(async () => {
      order.push("caller-session");
      return { identity: { enrollmentId: state.callerEnrollment ?? enrollmentId } };
    }),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const service = new CheckoutResolutionService(prisma as never, trust as never, audit as never);
  const resolve = () =>
    service.resolve(manager, branchId, callerSession, { idempotencyKey: key, workSessionId: originalSession });
  return { resolve, tx, trust, audit, order };
}

describe("CheckoutResolutionService", () => {
  it("takes the checkout's key lock, under the seller's scope, before the counter's session lock", async () => {
    const { resolve, order, trust } = setup({ committed: "sale-1" });
    await expect(resolve()).resolves.toMatchObject({ outcome: "landed", sale: { id: "sale-1" } });
    expect(order).toEqual(["original", `lock:checkout:${tenantId}:${sellerId}:${key}`, "caller-session"]);
    expect(trust.requireOpenSession).toHaveBeenCalledWith(expect.anything(), manager, branchId, callerSession);
  });

  it("finds the original only at this branch and under the seller's own key", async () => {
    const { resolve, tx } = setup({ committed: "sale-1" });
    await resolve();
    expect(tx.terminalStaffSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, branchId, id: originalSession } }),
    );
    expect(tx.idempotencyRecord.findUnique).toHaveBeenCalledWith({
      where: { tenantId_userId_scope_idempotencyKey: { tenantId, userId: sellerId, scope: "checkout", idempotencyKey: key } },
    });
    expect(tx.sale.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sale-1", tenantId, branchId, workSessionId: originalSession } }),
    );
  });

  it("seals a key that never landed, once, and audits who did", async () => {
    const { resolve, tx, audit } = setup();
    await expect(resolve()).resolves.toEqual({ outcome: "never_landed" });
    expect(tx.idempotencyRecord.create).toHaveBeenCalledWith({
      data: { tenantId, userId: sellerId, scope: CHECKOUT_SEALED_SCOPE, idempotencyKey: key, resourceId: callerSession },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: manager.userId, eventName: "sale.checkout_resolved" }),
    );
  });

  it("answers the same for a key already sealed, without sealing it again", async () => {
    const { resolve, tx, audit } = setup({ sealed: true });
    await expect(resolve()).resolves.toEqual({ outcome: "never_landed" });
    expect(tx.idempotencyRecord.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("refuses a sale from another counter's enrollment and seals nothing", async () => {
    const { resolve, tx } = setup({ callerEnrollment: "00000000-0000-4000-8000-0000000000c9" });
    await expect(resolve()).rejects.toMatchObject({ response: { code: "CHECKOUT_OTHER_COUNTER" } });
    expect(tx.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("refuses a key the seller used for a sale in another session", async () => {
    const { resolve } = setup({ committed: "sale-1", saleSession: "00000000-0000-4000-8000-0000000000e9" });
    await expect(resolve()).rejects.toMatchObject({ response: { code: "CHECKOUT_OTHER_COUNTER" } });
  });
});
