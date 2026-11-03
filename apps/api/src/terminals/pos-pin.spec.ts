import { ForbiddenException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import {
  MAX_PIN_LOCKOUTS,
  checkPosPin,
  pinRefusal,
  pinUnavailable,
  recordWrongPin,
} from "./pos-pin";

jest.mock("bcrypt");
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe("POS PIN lockout", () => {
  const now = new Date("2026-11-03T10:00:00.000Z");
  const later = new Date("2026-11-03T10:15:00.000Z");
  const account = {
    id: "user-1",
    posPinHash: "hash",
    posPinLockedUntil: null as Date | null,
    posPinLockouts: 0,
  };

  /** A transaction whose updates answer with the counts the database would. */
  function tx(failures: number, lockouts = 1) {
    const update = jest
      .fn()
      .mockResolvedValueOnce({ failedPosPinAttempts: failures })
      .mockResolvedValueOnce({ posPinLockouts: lockouts });
    return { update, client: { appUser: { update } } as never };
  }

  beforeEach(() => mockedBcrypt.compare.mockReset());

  it("puts a switch-off before a timed lock, and both before trying the PIN", () => {
    expect(pinUnavailable({ ...account, posPinHash: null }, now)).toEqual({
      outcome: "not_set",
      lockedUntil: null,
    });
    expect(
      pinUnavailable(
        {
          ...account,
          posPinLockouts: MAX_PIN_LOCKOUTS,
          posPinLockedUntil: later,
        },
        now,
      ),
    ).toEqual({ outcome: "switched_off", lockedUntil: null });
    expect(
      pinUnavailable({ ...account, posPinLockedUntil: later }, now),
    ).toEqual({ outcome: "locked", lockedUntil: later });
    expect(
      pinUnavailable({ ...account, posPinLockedUntil: now }, later),
    ).toBeNull();
  });

  it("counts a wrong PIN without locking until the fifth", async () => {
    const { update, client } = tx(4);
    await expect(recordWrongPin(client, "user-1", now)).resolves.toEqual({
      failures: 4,
      lockedUntil: null,
      switchedOff: false,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { failedPosPinAttempts: { increment: 1 } },
      }),
    );
  });

  it("locks for 15 minutes on the fifth, and counts the lock", async () => {
    const { update, client } = tx(5, 1);
    await expect(recordWrongPin(client, "user-1", now)).resolves.toEqual({
      failures: 5,
      lockedUntil: later,
      switchedOff: false,
    });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          failedPosPinAttempts: 0,
          posPinLockedUntil: later,
          posPinLockouts: { increment: 1 },
        },
      }),
    );
  });

  it("switches the PIN off on exactly the third lock", async () => {
    await expect(
      recordWrongPin(tx(5, MAX_PIN_LOCKOUTS).client, "user-1", now),
    ).resolves.toMatchObject({ switchedOff: true });
    // A guess that slipped in alongside counts, but doesn't alert a second time.
    await expect(
      recordWrongPin(tx(5, MAX_PIN_LOCKOUTS + 1).client, "user-1", now),
    ).resolves.toMatchObject({ switchedOff: false });
  });

  it("refuses a switched-off PIN without comparing it", async () => {
    const { update, client } = tx(0);
    await expect(
      checkPosPin(
        client,
        { ...account, posPinLockouts: MAX_PIN_LOCKOUTS },
        "1234",
        now,
      ),
    ).resolves.toEqual({
      outcome: "switched_off",
      lockedUntil: null,
      switchedOff: false,
    });
    expect(mockedBcrypt.compare).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the lock count through a right PIN: only the password clears it", async () => {
    mockedBcrypt.compare.mockResolvedValue(true as never);
    const { update, client } = tx(0);
    await expect(
      checkPosPin(client, { ...account, posPinLockouts: 2 }, "1234", now),
    ).resolves.toMatchObject({ outcome: "ok" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failedPosPinAttempts: 0 } }),
    );
  });

  it("says a switched-off PIN needs the password", () => {
    let error: unknown;
    try {
      pinRefusal("switched_off");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: "PIN_SWITCHED_OFF",
      message: expect.stringContaining("password"),
    });
  });
});
