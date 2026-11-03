import { ForbiddenException } from "@nestjs/common";
import { PinSignInService } from "./pin-sign-in.service";

// What PIN checks prove is covered against Postgres (test/integration/terminal-enrollment); this
// pins the order around them: the login is issued in the transaction that binds the till.
describe("PinSignInService.finish", () => {
  const tx = { name: "pin sign-in transaction" };
  const session = {
    workSessionId: "work-session-1",
    staffUserId: "user-1",
    registerId: "register-1",
    tillId: "till-1",
  };
  const body = { envelope: {}, attendance: {}, pin: "2468" };
  const login = {
    accessToken: "access",
    refreshToken: "refresh",
    user: {
      id: "user-1",
      tenantId: "tenant-1",
      email: "dilshan@example.lk",
      fullName: "Dilshan",
      roles: ["cashier"],
      branchRoles: [],
    },
  };

  function service(finished: unknown, issueCounterSession: jest.Mock) {
    const prisma = {
      $transaction: jest.fn((run: (client: unknown) => Promise<unknown>) =>
        run(tx),
      ),
    };
    const trust = { finishPinSession: jest.fn().mockResolvedValue(finished) };
    return {
      prisma,
      pinSignIn: new PinSignInService(
        prisma as never,
        trust as never,
        { recordForPinSession: jest.fn() } as never,
        { issueCounterSession } as never,
      ),
    };
  }

  it("issues the login inside the transaction that binds the till", async () => {
    const issue = jest.fn().mockResolvedValue(login);
    const { pinSignIn } = service(
      { outcome: "signed_in", tenantId: "tenant-1", session },
      issue,
    );

    const result = await pinSignIn.finish(body, {});

    expect(issue).toHaveBeenCalledWith(
      tx,
      "user-1",
      "tenant-1",
      "work-session-1",
      {},
    );
    expect(result).toMatchObject({ accessToken: "access", session });
  });

  it("fails the transaction itself when the login can't be issued, so the binding rolls back", async () => {
    const { pinSignIn, prisma } = service(
      { outcome: "signed_in", tenantId: "tenant-1", session },
      jest.fn().mockRejectedValue(new Error("token store down")),
    );

    await expect(pinSignIn.finish(body, {})).rejects.toThrow(
      "token store down",
    );
    await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
      "token store down",
    );
  });

  it("refuses after the transaction, saying until when a locked PIN is locked", async () => {
    const lockedUntil = new Date("2026-11-03T10:15:00.000Z");
    const issue = jest.fn();
    const { pinSignIn, prisma } = service(
      { outcome: "locked", lockedUntil },
      issue,
    );

    const error = await pinSignIn.finish(body, {}).catch((e: unknown) => e);

    // The refusal is thrown after the callback resolved, so the guess it counted is committed.
    await expect(prisma.$transaction.mock.results[0].value).resolves.toEqual({
      outcome: "locked",
      lockedUntil,
    });
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: "PIN_LOCKED",
      lockedUntil: "2026-11-03T10:15:00.000Z",
    });
    expect(issue).not.toHaveBeenCalled();
  });
});
