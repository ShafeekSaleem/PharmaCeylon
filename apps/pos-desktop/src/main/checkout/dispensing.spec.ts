import { randomUUID } from "node:crypto";
import type { ApiSession } from "../api/api-client";
import type { TerminalService } from "../terminal/terminal-service";
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

function service(reply: (path: string, opts: { body?: unknown }) => unknown) {
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
  return {
    calls,
    dispensing: new DispensingService({
      api: api as unknown as ApiSession,
      terminal: signedIn as unknown as TerminalService,
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

  it("records a prescription and lists co-signers with whether they have a PIN", async () => {
    const approverId = randomUUID();
    const { dispensing, calls } = service((path) =>
      path === "/prescriptions"
        ? rx("2026-12-01T00:00:00.000Z")
        : [{ id: approverId, fullName: "Pharmacist", hasPosPin: false }],
    );
    await expect(
      dispensing.record({ patientName: "Nimal Perera", doctorName: "Silva", issuedOn: "2026-10-20" }),
    ).resolves.toMatchObject({ validUntil: "2026-12-01", expired: false });
    await expect(dispensing.approvers()).resolves.toEqual([
      { userId: approverId, fullName: "Pharmacist", hasPin: false },
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /prescriptions",
      "GET /sales/pos/approvers",
    ]);
  });

  it("refuses when nobody is signed in", async () => {
    const api = { request: jest.fn() };
    const dispensing = new DispensingService({
      api: api as unknown as ApiSession,
      terminal: { current: () => null } as unknown as TerminalService,
    });
    await expect(dispensing.approvers()).rejects.toMatchObject({ code: "NOT_SIGNED_IN" });
    expect(api.request).not.toHaveBeenCalled();
  });
});
