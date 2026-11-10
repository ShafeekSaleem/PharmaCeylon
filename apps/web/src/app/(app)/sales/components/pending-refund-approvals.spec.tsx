import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import type { SaleRefundRequest } from "../types";
import PendingRefundApprovals from "./pending-refund-approvals";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
let mockBranch = "branch-a";
let mockCanSelfApprove = false;
let mockPermissions = ["returns.approve"];
const mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({ branchId: mockBranch, user: { id: "manager" } }),
}));
jest.mock("@/lib/permissions", () => ({
  usePermissions: () => ({
    permissionKeys: mockPermissions,
    canSelfApprove: mockCanSelfApprove,
    loading: false,
    hasLoadedOnce: true,
  }),
  hasPermission: (keys: string[], required: string[]) =>
    required.some((key) => keys.includes(key)),
}));
jest.mock("@/lib/use-role-access", () => ({
  useRoleAccess: () => ({ canAccess: () => true }),
}));

const request: SaleRefundRequest = {
  id: "refund-1",
  requestNumber: "RFR-00001",
  saleId: "sale-1",
  invoiceNo: "INV-00001",
  status: "prepared",
  lines: [
    {
      productId: "product-1",
      batchId: "batch-1",
      productName: "Paracetamol",
      batchNo: "LOT-17",
      qty: 2,
      unitPrice: "100.00",
      disposition: "quarantine",
    },
  ],
  amount: "200.00",
  refundMethod: null,
  reasonCode: "damaged",
  reason: "Packaging damaged",
  approvalRequired: true,
  executionApprovalId: null,
  approvalRevoked: false,
  readyAtCounter: false,
  approvalReview: { expectedVersion: 1, expectedDigest: "a".repeat(64) },
  approvalVersion: 1,
  requester: { id: "cashier", fullName: "Nimal" },
  requestedAt: "2026-11-09T04:00:00Z",
  approver: null,
  approvedAt: null,
  executor: null,
  executedAt: null,
  goodsReturnId: null,
  cancelledBy: null,
  cancelledAt: null,
};
let current: SaleRefundRequest;
const queue = (items = [current], total = items.length) => ({
  items: items.map((item) => ({
    id: `refund:${item.id}`, reference: item.requestNumber,
    kind: "sale_refund.approve", category: "counter", where: "web",
    title: "Approve prepared refund", detail: `${item.invoiceNo} � LKR ${item.amount}`,
    createdAt: item.requestedAt, status: item.status,
    blocked: item.requester?.id === "manager" && !mockCanSelfApprove,
  })),
  total,
  page: 1,
  pageSize: 25,
});

beforeEach(() => {
  mockBranch = "branch-a";
  mockCanSelfApprove = false;
  mockPermissions = ["returns.approve"];
  mockSearchParams.delete("request");
  current = { ...request };
  jest
    .mocked(apiJson)
    .mockReset()
    .mockImplementation(async (path, init) => {
      if (init?.method === "POST")
        return (current = {
          ...current,
          status: "approved",
          readyAtCounter: true,
          executionApprovalId: "approved-id",
          approver: { id: "manager", fullName: "Manager" },
        });
      if (String(path).startsWith("/dashboard/work?"))
        return queue(current.readyAtCounter ? [] : [current]);
      return current;
    });
  Object.defineProperty(global.crypto, "randomUUID", {
    configurable: true,
    value: jest.fn(() => "approval-id"),
  });
});

async function openReview() {
  fireEvent.click(await screen.findByText("RFR-00001"));
  return screen.findByRole("dialog");
}

it("allows an approver without sales.refund or sales.view to review exact lines and hand off, never execute", async () => {
  render(<PendingRefundApprovals />);
  const dialog = await openReview();
  expect(await within(dialog).findByText("Paracetamol")).toBeInTheDocument();
  expect(within(dialog).getByText("Batch LOT-17")).toBeInTheDocument();
  expect(within(dialog).getByText("Quarantine")).toBeInTheDocument();
  expect(
    within(dialog).getByText("Original payment method(s)"),
  ).toBeInTheDocument();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Approve refund" }),
  );
  await screen.findByText("Approved — waiting at the counter");
  const post = jest
    .mocked(apiJson)
    .mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(post[0]).toBe("/sales/refund-requests/refund-1/approve");
  expect(post[1]?.headers).toEqual({ "x-branch-id": "branch-a" });
  expect(JSON.parse(post[1]!.body as string)).toEqual({
    approvalId: "approval-id",
    ...request.approvalReview,
  });
  expect(
    jest
      .mocked(apiJson)
      .mock.calls.some(([path]) => String(path).includes("/execute")),
  ).toBe(false);
  expect(
    await screen.findByText("No refunds need approval"),
  ).toBeInTheDocument();
});

it("hides approval for one's own request unless self-approval is configured", async () => {
  current = { ...current, requester: { id: "manager", fullName: "Manager" } };
  const view = render(<PendingRefundApprovals />);
  const dialog = await openReview();
  await within(dialog).findByText(
    "You raised this refund. Another approver must review it.",
  );
  expect(
    within(dialog).queryByRole("button", { name: "Approve refund" }),
  ).not.toBeInTheDocument();
  mockCanSelfApprove = true;
  view.rerender(<PendingRefundApprovals />);
  expect(
    within(dialog).getByRole("button", { name: "Approve refund" }),
  ).toBeInTheDocument();
});

it("reloads current evidence after stale approval and requires another deliberate click", async () => {
  render(<PendingRefundApprovals />);
  const dialog = await openReview();
  await within(dialog).findByText("Paracetamol");
  const normal = jest.mocked(apiJson).getMockImplementation()!;
  jest.mocked(apiJson).mockImplementation(async (path, init) => {
    if (init?.method === "POST") {
      current = {
        ...current,
        approvalReview: { expectedVersion: 2, expectedDigest: "b".repeat(64) },
        approvalVersion: 2,
      };
      throw new Error("This changed. Review it again.");
    }
    return normal(path, init);
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Approve refund" }),
  );
  await within(dialog).findByText("This changed. Review it again.");
  expect(
    jest
      .mocked(apiJson)
      .mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(
    within(dialog).getByRole("button", { name: "Approve refund" }),
  ).toBeEnabled();
});

it("ignores a late old-branch response and pins the new approval to its branch", async () => {
  let finishOld!: (value: unknown) => void;
  const normal = jest.mocked(apiJson).getMockImplementation()!;
  jest.mocked(apiJson).mockImplementation((path, init) => {
    if (
      String(path).includes("?") &&
      (init?.headers as Record<string, string>)["x-branch-id"] === "branch-a"
    )
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    return normal(path, init);
  });
  const view = render(<PendingRefundApprovals />);
  mockBranch = "branch-b";
  current = { ...current, requestNumber: "RFR-B" };
  view.rerender(<PendingRefundApprovals />);
  await screen.findByText("RFR-B");
  await act(async () =>
    finishOld(queue([{ ...request, requestNumber: "RFR-OLD" }])),
  );
  expect(screen.queryByText("RFR-OLD")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("RFR-B"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve refund" }),
  );
  await waitFor(() =>
    expect(
      jest
        .mocked(apiJson)
        .mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.headers,
    ).toEqual({ "x-branch-id": "branch-b" }),
  );
});

it("opens notification deep links with fresh server data and cannot approve a cancelled request", async () => {
  mockSearchParams.set("request", request.id);
  current = { ...current, status: "cancelled", approvalReview: null };
  render(<PendingRefundApprovals />);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Cancelled");
  expect(
    within(dialog).queryByRole("button", { name: "Approve refund" }),
  ).not.toBeInTheDocument();
});

it("prevents duplicate submissions and reuses the approval ID after a lost response", async () => {
  render(<PendingRefundApprovals />);
  const dialog = await openReview();
  await within(dialog).findByText("Paracetamol");
  const normal = jest.mocked(apiJson).getMockImplementation()!;
  let fail!: (reason: Error) => void;
  jest.mocked(apiJson).mockImplementation((path, init) =>
    init?.method === "POST"
      ? new Promise((_resolve, reject) => {
          fail = reject;
        })
      : normal(path, init),
  );
  const button = within(dialog).getByRole("button", { name: "Approve refund" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(
    jest
      .mocked(apiJson)
      .mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  await act(async () => fail(new Error("Connection lost")));
  await within(dialog).findByText("Connection lost");
  jest.mocked(apiJson).mockImplementation(normal);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Approve refund" }),
  );
  await screen.findByText("Approved — waiting at the counter");
  const posts = jest
    .mocked(apiJson)
    .mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts[0]![1]!.body).toBe(posts[1]![1]!.body);
});

it("shows a load failure distinctly and recovers through Refresh", async () => {
  const normal = jest.mocked(apiJson).getMockImplementation()!;
  jest.mocked(apiJson).mockRejectedValue(new Error("API unavailable"));
  render(<PendingRefundApprovals />);
  await screen.findByText("API unavailable");
  jest.mocked(apiJson).mockImplementation(normal);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("RFR-00001");
  expect(screen.queryByText("API unavailable")).not.toBeInTheDocument();
});

it("does not fetch the inbox without approve permission", () => {
  mockPermissions = ["sales.view", "sales.refund"];
  render(<PendingRefundApprovals />);
  expect(screen.getByText("Insufficient permissions")).toBeInTheDocument();
  expect(apiJson).not.toHaveBeenCalled();
});

it("searches on the server and paginates rather than truncating to 200 requests", async () => {
  jest.mocked(apiJson).mockResolvedValue(queue([current], 250));
  render(<PendingRefundApprovals />);
  await screen.findByText("250 waiting for approval");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(
      jest
        .mocked(apiJson)
        .mock.calls.some(([path]) => String(path).includes("page=2")),
    ).toBe(true),
  );
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "INV-%_" },
  });
  await waitFor(() =>
    expect(
      jest
        .mocked(apiJson)
        .mock.calls.some(
          ([path]) =>
            String(path).includes("q=INV-%25_") &&
            String(path).includes("page=1"),
        ),
    ).toBe(true),
  );
});
