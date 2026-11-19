/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { SupplierCashPayoutView } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import { CashPayoutDetail } from "./cash-payout-detail";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/permissions", () => ({
  hasPermission: (granted: string[], required?: string[]) =>
    !required || required.length === 0 || required.some((k) => granted.includes(k)),
  usePermissions: jest.fn(),
}));

jest.mock("../hooks/use-ledger", () => ({
  useInvoices: () => ({
    rows: [{ id: "22222222-2222-4222-8222-222222222222", invoiceNumber: "INV-100", balance: "12500" }],
    fresh: true,
  }),
}));

const basePayout = (): SupplierCashPayoutView => ({
  id: "11111111-1111-4111-8111-111111111111",
  payoutNumber: "SCP-0042",
  status: "prepared",
  supplier: { id: "s1", code: "HEM", name: "Hemas Pharmaceuticals" },
  purchaseOrder: null,
  amount: "12500.00",
  paidOn: "2026-11-14",
  reference: null,
  notes: null,
  allocations: [{ invoiceId: "22222222-2222-4222-8222-222222222222", amount: "12500.00" }],
  executionApprovalId: "33333333-3333-4333-8333-333333333333",
  approvalRevoked: false,
  readyAtCounter: false,
  approvalReview: { expectedVersion: 1, expectedDigest: "digest-1" },
  approvalVersion: 1,
  requester: { id: "u1", fullName: "Kasun Jayasinghe" },
  requestedAt: "2026-11-14T10:00:00.000Z",
  approver: null,
  approvedAt: null,
  executor: null,
  executedAt: null,
  supplierPaymentId: null,
  supplierPaymentNo: null,
  cancelledBy: null,
  cancelledAt: null,
});

function grantPay(keys: string[] = ["suppliers.pay"]) {
  jest.mocked(useAuth).mockReturnValue({ branchId: "branch-a", user: { id: "user-a" } } as never);
  jest.mocked(usePermissions).mockReturnValue({
    permissionKeys: keys,
    loading: false,
    hasLoadedOnce: true,
  } as never);
}

beforeEach(() => {
  jest.mocked(apiJson).mockReset();
  grantPay();
});

describe("CashPayoutDetail", () => {
  it("shows waiting at the counter for an approved payout", () => {
    const payout = { ...basePayout(), status: "approved" as const, readyAtCounter: true, approvalReview: null };
    payout.approver = { id: "u2", fullName: "Dilini Fernando" };
    payout.approvedAt = "2026-11-14T11:00:00.000Z";
    render(
      <CashPayoutDetail
        payout={payout}
        branchName="Kollupitiya"
        invoiceNumbers={new Map([["22222222-2222-4222-8222-222222222222", "INV-100"]])}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Waiting at the counter" })).toBeTruthy();
    expect(screen.getByText(/Cash & shift/)).toBeTruthy();
  });

  it("shows the self-approve note when the same person prepared and approved", () => {
    const payout = {
      ...basePayout(),
      status: "approved" as const,
      readyAtCounter: true,
      approvalReview: null,
      approver: { id: "u1", fullName: "Kasun Jayasinghe" },
      approvedAt: "2026-11-14T10:05:00.000Z",
    };
    render(
      <CashPayoutDetail payout={payout} branchName="Kollupitiya" invoiceNumbers={new Map()} onChanged={() => undefined} />,
    );
    expect(screen.getByText(/Prepared and approved in one step by Kasun Jayasinghe/)).toBeTruthy();
  });

  it("hides approve and cancel when the user cannot pay", () => {
    grantPay([]);
    render(
      <CashPayoutDetail payout={basePayout()} branchName="Kollupitiya" invoiceNumbers={new Map()} onChanged={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows approve and cancel for a prepared payout when the user can pay", () => {
    render(
      <CashPayoutDetail payout={basePayout()} branchName="Kollupitiya" invoiceNumbers={new Map()} onChanged={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("approves with a stable approvalId across confirmation retries", async () => {
    const randomUUID = jest.fn().mockReturnValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    Object.defineProperty(globalThis, "crypto", { value: { randomUUID }, configurable: true });
    jest
      .mocked(apiJson)
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ status: "approved" });
    const onChanged = jest.fn(async () => undefined);
    render(
      <CashPayoutDetail payout={basePayout()} branchName="Kollupitiya" invoiceNumbers={new Map()} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve payout" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    expect(apiJson).toHaveBeenCalledWith(
      "/purchasing/cash-payouts/11111111-1111-4111-8111-111111111111/approve",
      expect.objectContaining({ method: "POST" }),
    );
    const firstBody = JSON.parse(String(jest.mocked(apiJson).mock.calls[0]?.[1]?.body));
    expect(firstBody).toMatchObject({ expectedVersion: 1, expectedDigest: "digest-1" });
    expect(firstBody.approvalId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(screen.getByText(/Network error/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve payout" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(jest.mocked(apiJson).mock.calls[1]?.[1]?.body)).approvalId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("issues a new approvalId when the payout approval version changes", async () => {
    const randomUUID = jest
      .fn()
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    Object.defineProperty(globalThis, "crypto", { value: { randomUUID }, configurable: true });
    jest.mocked(apiJson).mockResolvedValue({ status: "approved" });
    const view: RenderResult = render(
      <CashPayoutDetail
        payout={basePayout()}
        branchName="Kollupitiya"
        invoiceNumbers={new Map()}
        onChanged={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve payout" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(jest.mocked(apiJson).mock.calls[0]?.[1]?.body)).approvalId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    view.rerender(
      <CashPayoutDetail
        payout={{ ...basePayout(), approvalVersion: 2, approvalReview: { expectedVersion: 2, expectedDigest: "digest-2" } }}
        branchName="Kollupitiya"
        invoiceNumbers={new Map()}
        onChanged={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve payout" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(jest.mocked(apiJson).mock.calls[1]?.[1]?.body)).approvalId).toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
  });

  it("cancels a prepared payout", async () => {
    jest.mocked(apiJson).mockResolvedValueOnce({ status: "cancelled" });
    const onChanged = jest.fn(async () => undefined);
    render(
      <CashPayoutDetail payout={basePayout()} branchName="Kollupitiya" invoiceNumbers={new Map()} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel payout" }));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith("/purchasing/cash-payouts/11111111-1111-4111-8111-111111111111/cancel", {
        method: "POST",
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
