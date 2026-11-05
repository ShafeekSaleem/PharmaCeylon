import { randomUUID } from "node:crypto";
import { ApiError, type ApiSession } from "../api/api-client";
import { CounterWorkService } from "./counter-work";
import type { SignedCommandService } from "./signed-commands";
import type { TerminalService } from "./terminal-service";

const branchId = randomUUID();
const refundId = randomUUID();
const approvalId = randomUUID();

function service(reply: (path: string) => unknown) {
  const calls: { method: string; path: string; branchId?: string }[] = [];
  const api = {
    request: async (method: string, path: string, opts: { branchId?: string }) => {
      calls.push({ method, path, branchId: opts.branchId });
      const answer = reply(path);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const terminal = { current: () => ({ identity: { branchId } }) };
  return {
    calls,
    work: new CounterWorkService({
      api: api as unknown as ApiSession,
      terminal: terminal as unknown as TerminalService,
      commands: {} as SignedCommandService,
    }),
  };
}

const item = {
  kind: "prepared_receipt",
  id: randomUUID(),
  reference: "PO-2026-0187",
  subject: "Hemas Pharmaceuticals",
  lineCount: 12,
  amount: "184320.00",
  readyAt: "2026-11-01T08:20:00.000Z",
  requested: { name: "Kasun Jayasinghe", at: "2026-10-29T03:42:00.000Z" },
  approved: { name: "Dilini Fernando", at: "2026-10-29T05:10:00.000Z" },
  dispatched: null,
  approval: { evidenceId: approvalId, approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] },
  operation: "POST /api/v1/purchasing/prepared-receipts/:id/post",
};

describe("counter work from the server", () => {
  it("reads this branch's web-approved work from GET /counter-work", async () => {
    const { work, calls } = service(() => [item]);
    await expect(work.list()).resolves.toEqual([item]);
    expect(calls).toEqual([{ method: "GET", path: "/counter-work", branchId }]);
  });

  it("shows nothing waiting to someone the server won't show counter work to", async () => {
    const { work } = service(() => new ApiError(403, "PERMISSION_DENIED", "No"));
    await expect(work.list()).resolves.toEqual([]);
  });

  it("still lists ready refunds from a server without the route", async () => {
    const { work, calls } = service((path) =>
      path === "/counter-work"
        ? new ApiError(404, "NOT_FOUND", "Cannot GET")
        : [
            {
              id: refundId, requestNumber: "RF-0031", invoiceNo: "INV-1", amount: "1840.00", refundMethod: null,
              reason: "Wrong item", executionApprovalId: approvalId, readyAtCounter: true,
              requester: { id: randomUUID(), fullName: "Kasun" }, approver: { id: randomUUID(), fullName: "Dilini" },
              approvalRequired: true, requestedAt: "2026-11-01T05:00:00.000Z", approvedAt: "2026-11-01T06:10:00.000Z",
            },
            {
              id: randomUUID(), requestNumber: "RF-0032", invoiceNo: null, amount: "10.00", refundMethod: null,
              reason: "Waiting", executionApprovalId: null, readyAtCounter: false, requester: null, approver: null,
              approvalRequired: true,
            },
          ],
    );
    const list = await work.list();
    expect(calls.map((c) => c.path)).toEqual(["/counter-work", "/sales/refund-requests"]);
    expect(list).toEqual([
      expect.objectContaining({
        kind: "refund",
        id: refundId,
        reference: "RF-0031",
        subject: "INV-1",
        readyAt: "2026-11-01T06:10:00.000Z",
        requested: { name: "Kasun", at: "2026-11-01T05:00:00.000Z" },
        approved: { name: "Dilini", at: "2026-11-01T06:10:00.000Z" },
        approval: expect.objectContaining({ evidenceId: approvalId, state: "matches" }),
      }),
    ]);
  });

  it("passes other failures on, so the page keeps the list it had", async () => {
    const { work } = service(() => new ApiError(0, "NETWORK", "offline"));
    await expect(work.list()).rejects.toBeInstanceOf(ApiError);
  });
});
