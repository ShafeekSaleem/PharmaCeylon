import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import type { AuthUser } from "@/lib/auth-types";
import { useBranchRollout } from "@/lib/branch-rollout";
import type { TransferListItem } from "../types";
import { TransferDetailModal } from "./transfer-detail-modal";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/branch-rollout", () => ({ useBranchRollout: jest.fn() }));
jest.mock("@/lib/permissions", () => ({ usePermissions: () => ({ canSelfApprove: true }) }));

const SOURCE = "branch-colombo";
const DESTINATION = "branch-kandy";
const manager: AuthUser = {
  id: "user-manager",
  tenantId: "tenant-1",
  email: "m@example.test",
  fullName: "Manager",
  avatarUrl: null,
  roles: ["manager"],
  branchRoles: [
    { branchId: SOURCE, role: "manager" },
    { branchId: DESTINATION, role: "manager" },
  ] as AuthUser["branchRoles"],
};

function transfer(overrides: Partial<TransferListItem> = {}): TransferListItem {
  return {
    id: "transfer-1",
    transferNumber: "TR-00012",
    status: "requested",
    fromBranchId: SOURCE,
    toBranchId: DESTINATION,
    notes: null,
    expectedOn: null,
    requestedBy: "user-clerk",
    approvedBy: null,
    receivedBy: null,
    createdAt: "2026-10-27T04:00:00.000Z",
    updatedAt: "2026-10-27T04:00:00.000Z",
    fromBranch: { id: SOURCE, code: "CMB", name: "Colombo" },
    toBranch: { id: DESTINATION, code: "KDY", name: "Kandy" },
    requester: { id: "user-clerk", fullName: "Clerk" },
    approver: null,
    receiver: null,
    items: [
      {
        id: "item-1",
        productId: "p-1",
        batchId: "b-1",
        qty: 5,
        receivedQty: 0,
        product: { id: "p-1", sku: "PCM", name: "Paracetamol" },
        batch: { id: "b-1", batchNo: "B-1" },
      },
    ],
    totalQty: 5,
    approvalVersion: 2,
    executionApprovalId: null,
    approvedVersion: null,
    approvalWaived: false,
    approvalReview: { expectedVersion: 2, expectedDigest: "a".repeat(64) },
    ...overrides,
  };
}

const approved = () =>
  transfer({
    status: "approved",
    approvedBy: "user-manager",
    approver: { id: "user-manager", fullName: "Manager" },
    executionApprovalId: "approval-1",
    approvedVersion: 2,
  });

function renderModal(row: TransferListItem, branchId: string, state: "not_live" | "live" | null) {
  jest.mocked(useBranchRollout).mockReturnValue({
    rollout: state ? { state, liveSince: null, fallback: null } : null,
    loading: false,
    resolved: state !== null,
    failed: false,
  });
  const onChanged = jest.fn();
  render(
    <TransferDetailModal
      transfer={row}
      branchId={branchId}
      canWrite
      user={manager}
      onClose={jest.fn()}
      onChanged={onChanged}
    />,
  );
  return { onChanged };
}

beforeEach(() => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => "12345678-1234-4234-8234-123456789abc",
  });
  jest.mocked(apiJson).mockReset();
  jest.mocked(apiJson).mockResolvedValue({});
});

describe("TransferDetailModal", () => {
  it("approves the exact displayed version and digest", async () => {
    renderModal(transfer(), SOURCE, "live");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    const [path, init] = jest.mocked(apiJson).mock.calls[0]!;
    expect(path).toBe("/transfers/transfer-1/approve");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      approvalId: "12345678-1234-4234-8234-123456789abc",
      expectedVersion: 2,
      expectedDigest: "a".repeat(64),
    });
  });

  it("hands dispatch to the counter at a live branch", () => {
    renderModal(approved(), SOURCE, "live");
    expect(screen.queryByRole("button", { name: /Ship/ })).toBeNull();
    expect(screen.getByText("Approved — waiting at the counter")).toBeTruthy();
    expect(screen.getByText(/Dispatch the goods/)).toBeTruthy();
  });

  it("fails closed while the branch's rollout is unknown", () => {
    renderModal(approved(), SOURCE, null);
    expect(screen.queryByRole("button", { name: /Ship/ })).toBeNull();
  });

  it("dispatches on the web only at a not-live branch, pinned to the shown approval", async () => {
    renderModal(approved(), SOURCE, "not_live");
    fireEvent.click(screen.getByRole("button", { name: "Ship / dispatch" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    const [path, init] = jest.mocked(apiJson).mock.calls[0]!;
    expect(path).toBe("/transfers/transfer-1/ship");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ approvalId: "approval-1" });
  });

  it("asks for fresh approval instead of dispatch when the approval was revoked", () => {
    renderModal({ ...approved(), approvalRevoked: true }, SOURCE, "not_live");
    expect(screen.queryByRole("button", { name: "Ship / dispatch" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("hands receipt to the destination counter and shows what is in transit", () => {
    renderModal({ ...approved(), status: "in_transit", inTransitQty: 5 }, DESTINATION, "live");
    expect(screen.queryByRole("button", { name: /Receive all/ })).toBeNull();
    expect(screen.getByText(/Count and receive the goods/)).toBeTruthy();
    expect(screen.getByText("5 units")).toBeTruthy();
  });

  it("receives on the web at a not-live destination, pinned to the dispatch", async () => {
    renderModal({ ...approved(), status: "in_transit" }, DESTINATION, "not_live");
    fireEvent.click(screen.getByRole("button", { name: "Receive all remaining" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    const [path, init] = jest.mocked(apiJson).mock.calls[0]!;
    expect(path).toBe("/transfers/transfer-1/receive");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ dispatchApprovalId: "approval-1" });
  });
});
