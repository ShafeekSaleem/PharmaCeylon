import { ForbiddenException } from "@nestjs/common";
import type { AccessService } from "./access.service";
import {
  WORKER_AUTHORITY_REVOKED,
  WorkerAuthority,
  WorkerAuthorityRevokedError,
  workerInitiator,
} from "./worker-authority";

const initiator = (branchId: string | null = "b1") =>
  workerInitiator({ tenantId: "t1", userId: "u1", tokenVersion: 3 }, branchId, "products.import");

function setup(grants: Record<string, string[] | Error>, assignments = Object.keys(grants)) {
  const resolveLive = jest.fn(async (user: { tokenVersion: number }, branchId: string) => {
    const grant = grants[branchId];
    if (grant instanceof Error) throw grant;
    if (!grant) throw new ForbiddenException("No current branch assignment");
    return { has: (key: string) => grant.includes(key) };
  });
  const tx = {
    userBranchRole: {
      findMany: jest.fn(async () => assignments.map((branchId) => ({ branchId }))),
    },
  };
  return {
    workers: new WorkerAuthority({ resolveLive } as unknown as AccessService),
    resolveLive,
    tx: tx as never,
  };
}

describe("workerInitiator", () => {
  it("captures the request's token version, branch and permission", () => {
    expect(initiator()).toEqual({
      tenantId: "t1",
      userId: "u1",
      tokenVersion: 3,
      branchId: "b1",
      permission: "products.import",
    });
    expect(Object.isFrozen(initiator())).toBe(true);
  });

  it("refuses a request without a validated token version", () => {
    expect(() =>
      workerInitiator({ tenantId: "t1", userId: "u1" }, "b1", "products.import"),
    ).toThrow(ForbiddenException);
  });

  it("refuses a permission outside the catalog", () => {
    expect(() =>
      workerInitiator({ tenantId: "t1", userId: "u1", tokenVersion: 0 }, null, "jobs.anything"),
    ).toThrow("Unknown permission");
  });
});

describe("WorkerAuthority.assertCurrent", () => {
  it("checks the recorded branch with the recorded token version", async () => {
    const { workers, resolveLive, tx } = setup({ b1: ["products.import"] });
    await expect(workers.assertCurrent(tx, initiator())).resolves.toBeUndefined();
    expect(resolveLive).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", userId: "u1", tokenVersion: 3 }),
      "b1",
      tx,
    );
  });

  it("stops the job when the permission was removed at that branch", async () => {
    const { workers, tx } = setup({ b1: ["products.view"], b2: ["products.import"] });
    const error = await workers.assertCurrent(tx, initiator()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerAuthorityRevokedError);
    expect((error as WorkerAuthorityRevokedError).getResponse()).toMatchObject({
      code: WORKER_AUTHORITY_REVOKED,
    });
  });

  it("stops the job when the sign-in changed (live check refuses)", async () => {
    const { workers, tx } = setup({
      b1: new ForbiddenException("Live branch authentication required"),
    });
    await expect(workers.assertCurrent(tx, initiator())).rejects.toBeInstanceOf(
      WorkerAuthorityRevokedError,
    );
  });

  it("accepts any current branch for tenant-wide catalog work", async () => {
    const { workers, tx } = setup({ b1: ["products.view"], b2: ["products.import"] });
    await expect(workers.assertCurrent(tx, initiator(null))).resolves.toBeUndefined();
  });

  it("stops tenant-wide work when no branch still grants it", async () => {
    const { workers, tx } = setup({ b1: ["products.view"] });
    await expect(workers.assertCurrent(tx, initiator(null))).rejects.toBeInstanceOf(
      WorkerAuthorityRevokedError,
    );
    const none = setup({}, []);
    await expect(none.workers.assertCurrent(none.tx, initiator(null))).rejects.toBeInstanceOf(
      WorkerAuthorityRevokedError,
    );
  });

  it("lets infrastructure errors escape instead of reporting them as revocation", async () => {
    const { workers, tx } = setup({ b1: new Error("connection reset") });
    await expect(workers.assertCurrent(tx, initiator())).rejects.toThrow("connection reset");
  });
});
