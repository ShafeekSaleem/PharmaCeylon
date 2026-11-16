import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TerminalTrustService } from "./terminal-trust.service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BRANCH = "33333333-3333-4333-8333-333333333333";
const OTHER_BRANCH = "44444444-4444-4444-8444-444444444444";

/** An in-memory stand-in for terminal_counter that answers the duplicate probe the way SQL would. */
function harness(failCreateWith?: unknown) {
  const rows: { branchId: string; label: string }[] = [];
  const create = jest.fn(async ({ data }: { data: any }) => {
    if (failCreateWith) throw failCreateWith;
    rows.push({ branchId: data.branchId, label: data.label });
    return { id: "c", tillId: "t", isActive: true, ...data };
  });
  const tx: any = {
    terminalCounter: { create },
    $queryRaw: jest.fn(async (_s: unknown, _t: string, branchId: string, name: string) =>
      rows
        .filter(
          (r) =>
            r.branchId === branchId &&
            r.label.trim().toLowerCase() === name.toLowerCase(),
        )
        .map(() => ({ id: "x" })),
    ),
  };
  const service = new TerminalTrustService(
    { resolveLive: async () => ({ has: () => true }) } as any,
    { log: jest.fn() } as any,
    {} as any,
  );
  const user: any = { tenantId: TENANT, userId: USER };
  return {
    rows,
    create,
    add: (branch: string, label: string) => service.createCounter(tx, user, branch, label),
  };
}

describe("TerminalTrustService.createCounter name uniqueness (#179)", () => {
  it("creates a counter and stores the trimmed name", async () => {
    const h = harness();
    await h.add(BRANCH, "  Counter 1 ");
    expect(h.rows).toEqual([{ branchId: BRANCH, label: "Counter 1" }]);
  });

  it("refuses a second counter with the same name at the branch", async () => {
    const h = harness();
    await h.add(BRANCH, "Counter 1");
    const failure = h.add(BRANCH, "Counter 1");
    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toMatchObject({
      response: { message: "A counter named 'Counter 1' already exists at this branch" },
    });
    expect(h.rows).toHaveLength(1);
  });

  it.each(["counter 1", "COUNTER 1", "  Counter 1  "])(
    "treats %j as the same name",
    async (variant) => {
      const h = harness();
      await h.add(BRANCH, "Counter 1");
      await expect(h.add(BRANCH, variant)).rejects.toBeInstanceOf(ConflictException);
      expect(h.rows).toHaveLength(1);
    },
  );

  it("allows the same name at a different branch", async () => {
    const h = harness();
    await h.add(BRANCH, "Counter 1");
    await h.add(OTHER_BRANCH, "Counter 1");
    expect(h.rows).toHaveLength(2);
  });

  it("answers a unique-index race with the same conflict", async () => {
    const race = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    const h = harness(race);
    await expect(h.add(BRANCH, "Counter 1")).rejects.toMatchObject({
      response: { message: "A counter named 'Counter 1' already exists at this branch" },
    });
  });

  it("lets other database errors through", async () => {
    const h = harness(new Error("boom"));
    await expect(h.add(BRANCH, "Counter 1")).rejects.toThrow("boom");
  });
});
