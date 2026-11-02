import { randomUUID } from "node:crypto";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SignedCommandService } from "../terminal/signed-commands";
import {
  ActionFailure,
  type TerminalService,
} from "../terminal/terminal-service";
import { DispensingService, toPrescription } from "./dispensing";

const branchId = randomUUID();
const now = new Date("2026-11-01T10:00:00.000Z");

const rx = (validUntil: string | null) => ({
  id: randomUUID(),
  rxNumber: "RX-00012",
  patientName: "Nimal Perera",
  doctorName: "Silva",
  issuedOn: "2026-10-20T00:00:00.000Z",
  validUntil,
  customerId: null,
  customer: null,
});

function service(
  reply: (path: string, opts: { body?: unknown }) => unknown,
  execute: (operation: string, body: unknown, approval: unknown) => unknown = () => {
    throw new Error("no signed command expected");
  },
) {
  const calls: { method: string; path: string; branchId?: string }[] = [];
  const api = {
    request: async (
      method: string,
      path: string,
      opts: { body?: unknown; branchId?: string } = {},
    ) => {
      calls.push({ method, path, branchId: opts.branchId });
      return reply(path, opts);
    },
  };
  const signedIn = { current: () => ({ identity: { branchId } }) };
  const commands = { execute: jest.fn(async (...args: [string, unknown, unknown]) => execute(...args)) };
  return {
    calls,
    commands,
    dispensing: new DispensingService({
      api: api as unknown as ApiSession,
      terminal: signedIn as unknown as TerminalService,
      commands: commands as unknown as SignedCommandService,
      now: () => now,
    }),
  };
}

describe("DispensingService", () => {
  it("marks a prescription expired from the day after validUntil, as the server does", () => {
    expect(toPrescription(rx("2026-11-01T00:00:00.000Z"), now).expired).toBe(false);
    expect(toPrescription(rx("2026-10-31T00:00:00.000Z"), now).expired).toBe(true);
    expect(toPrescription(rx(null), now)).toMatchObject({
      expired: false,
      issuedOn: "2026-10-20",
      validUntil: null,
    });
  });

  it("searches a customer's prescriptions at the counter's branch", async () => {
    const customerId = randomUUID();
    const { dispensing, calls } = service(() => [rx(null)]);
    const [found] = await dispensing.prescriptions({ customerId });
    expect(found).toMatchObject({ rxNumber: "RX-00012", patientName: "Nimal Perera" });
    expect(calls[0]).toEqual({
      method: "GET",
      path: `/prescriptions?take=20&customerId=${customerId}`,
      branchId,
    });
  });

  it("lists co-signers with whether they have a PIN", async () => {
    const approverId = randomUUID();
    const { dispensing, calls } = service(() => [
      { id: approverId, fullName: "Pharmacist", hasPosPin: false },
    ]);
    await expect(dispensing.approvers()).resolves.toEqual([
      { userId: approverId, fullName: "Pharmacist", hasPin: false },
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /sales/pos/approvers"]);
  });

  describe("recording a prescription (signed clinical command)", () => {
    const prescriptionId = randomUUID();
    const customerId = randomUUID();
    const recorded = {
      result: {
        type: "prescription.recorded",
        prescriptionId,
        rxNumber: "RX-00031",
        pharmacistRegistrationId: randomUUID(),
      },
    };

    it("signs every key, blanks as null, never through the unsigned browser route", async () => {
      const { dispensing, calls, commands } = service(
        () => {
          throw new Error("no plain request expected");
        },
        () => recorded,
      );
      await expect(
        dispensing.record({
          patientName: "Nimal Perera",
          doctorName: "Silva",
          doctorRegNo: "",
          issuedOn: "2026-10-20",
          validUntil: "2026-10-31",
          customerId,
        }),
      ).resolves.toEqual({
        prescriptionId,
        rxNumber: "RX-00031",
        patientName: "Nimal Perera",
        doctorName: "Silva",
        issuedOn: "2026-10-20",
        validUntil: "2026-10-31",
        // Lapsed already: the same boundary as a prescription read from the server.
        expired: true,
        customerId,
        customerName: null,
      });
      expect(commands.execute).toHaveBeenCalledWith(
        "POST /api/v1/prescriptions",
        {
          rxNumber: null,
          patientName: "Nimal Perera",
          doctorName: "Silva",
          doctorRegNo: null,
          issuedOn: "2026-10-20",
          validUntil: "2026-10-31",
          customerId,
          notes: null,
        },
        null,
      );
      expect(calls).toEqual([]);
    });

    it("says who can record it when the signed-in person isn't a registered pharmacist", async () => {
      const { dispensing } = service(
        () => undefined,
        () => {
          throw new ApiError(403, "PHARMACIST_REQUIRED", "Terminal authorization failed");
        },
      );
      const refusal = dispensing.record({
        patientName: "Nimal Perera",
        doctorName: "Silva",
        issuedOn: "2026-10-20",
      });
      await expect(refusal).rejects.toBeInstanceOf(ActionFailure);
      await expect(refusal).rejects.toMatchObject({
        code: "PHARMACIST_REQUIRED",
        message: expect.stringContaining("current SLMC registration"),
      });
    });

    it("warns that an unanswered command may have saved it, and passes other refusals through", async () => {
      const uncertain = service(
        () => undefined,
        () => {
          throw new ActionFailure("COMMAND_UNCERTAIN", "The server did not answer.");
        },
      );
      await expect(
        uncertain.dispensing.record({ patientName: "Nimal", doctorName: "Silva", issuedOn: "2026-10-20" }),
      ).rejects.toMatchObject({
        code: "COMMAND_UNCERTAIN",
        message: expect.stringContaining("may have been saved"),
      });
      const hours = new ApiError(403, "OUTSIDE_OPERATING_HOURS", "Closed");
      const closed = service(
        () => undefined,
        () => {
          throw hours;
        },
      );
      await expect(
        closed.dispensing.record({ patientName: "Nimal", doctorName: "Silva", issuedOn: "2026-10-20" }),
      ).rejects.toBe(hours);
    });
  });

  it("refuses when nobody is signed in", async () => {
    const api = { request: jest.fn() };
    const dispensing = new DispensingService({
      api: api as unknown as ApiSession,
      terminal: { current: () => null } as unknown as TerminalService,
      commands: {} as SignedCommandService,
    });
    await expect(dispensing.approvers()).rejects.toMatchObject({ code: "NOT_SIGNED_IN" });
    expect(api.request).not.toHaveBeenCalled();
  });
});
