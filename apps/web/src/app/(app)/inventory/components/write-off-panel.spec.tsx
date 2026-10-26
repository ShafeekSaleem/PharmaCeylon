import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WriteOffPanel } from "./write-off-panel";
import { apiJson } from "@/lib/auth-client";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "branch", user: { id: "cashier" } }) }));
jest.mock("../hooks/use-inventory-access", () => ({ useInventoryAccess: () => ({ canWriteOff: true }) }));
jest.mock("@/lib/permissions", () => ({ usePermissions: () => ({ canSelfApprove: false }) }));
const base = { id: "held", status: "awaiting_approval", executionApprovalId: null, qty: 2, kindLabel: "Lost",
  product: { name: "Test tablets" }, batch: { batchNo: "B-1" }, requester: { id: "other", fullName: "Colleague" },
  approvalReview: { expectedVersion: 1, expectedDigest: "a".repeat(64) } };

it("approval does not post stock until the separate Post write-off action is selected", async () => {
  let row = { ...base, executionApprovalId: null as string | null };
  jest.mocked(apiJson).mockImplementation(async (path, options) => {
    if (path === "/inventory/held-adjustments") return [row] as never;
    if (path === "/inventory/write-offs/summary") return { rows: [] } as never;
    if (String(path).endsWith("/accept")) row = { ...row, status: "approved", executionApprovalId: "approval-id" };
    return {} as never;
  });
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: () => "approval-id" });
  render(<WriteOffPanel onChanged={jest.fn()} onError={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve write-off" }));
  const postButton = await screen.findByRole("button", { name: "Post write-off" });
  expect(apiJson).not.toHaveBeenCalledWith(expect.stringMatching(/\/post$/), expect.anything());
  expect(apiJson).toHaveBeenCalledWith("/inventory/held-adjustments/held/accept", expect.objectContaining({
    body: JSON.stringify({ approvalId: "approval-id", ...base.approvalReview }),
  }));
  fireEvent.click(postButton);
  await waitFor(() => expect(apiJson).toHaveBeenCalledWith("/inventory/held-adjustments/held/post", expect.objectContaining({ method: "POST" })));
});

it("allows posting someone else's approval even when the requester cannot self-approve", async () => {
  jest.mocked(apiJson).mockImplementation(async path => String(path).endsWith("/summary") ? { rows: [] } as never
    : [{ ...base, status: "approved", executionApprovalId: "approval-id", requester: { id: "cashier", fullName: "Me" } }] as never);
  render(<WriteOffPanel onChanged={jest.fn()} onError={jest.fn()} />);
  expect(await screen.findByRole("button", { name: "Post write-off" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Review approval" })).not.toBeInTheDocument();
});
