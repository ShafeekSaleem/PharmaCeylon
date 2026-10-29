import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import type { PosRolloutState } from "@/lib/branch-rollout";
import type { AuthUser } from "@/lib/auth-types";
import type { ReturnListItem } from "../types";
import { ReturnDetailModal } from "./return-detail-modal";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/permissions", () => ({
  ...jest.requireActual("@/lib/permissions"),
  usePermissions: () => ({ permissionKeys: ["returns.approve", "returns.process"], canSelfApprove: true }),
}));
let rolloutState: PosRolloutState | null = "not_live";
jest.mock("@/lib/branch-rollout", () => ({
  useBranchRollout: () => ({
    rollout: rolloutState ? { state: rolloutState, liveSince: null, fallback: null } : null,
    loading: false, resolved: rolloutState !== null, failed: false,
  }),
}));

const branchId = "branch-1";
const user = { id: "manager", tenantId: "t", email: "m@x", fullName: "Manager", avatarUrl: null, roles: ["manager"],
  branchRoles: [{ branchId, role: "manager" }] } as AuthUser;
const review = { expectedVersion: 4, expectedDigest: "b".repeat(64) };
function supplierReturn(overrides: Partial<ReturnListItem> = {}): ReturnListItem {
  return { id: "ret-1", returnNumber: "RET-2026-00001", type: "supplier", status: "pending_approval",
    customerName: null, reason: "Damaged", notes: null, amount: "40.00", branchId, requestedBy: "clerk",
    createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z", requester: { id: "clerk", fullName: "Clerk" },
    branch: { id: branchId, code: "MAIN", name: "Main branch" }, supplier: { id: "s", name: "Supplier", code: "S" },
    items: [], approvalReview: review, executionApprovalId: null, ...overrides } as ReturnListItem;
}
const open = (row: ReturnListItem) =>
  render(<ReturnDetailModal returnItem={row} branchId={branchId} user={user} onClose={jest.fn()} onChanged={jest.fn()} />);

beforeEach(() => {
  jest.clearAllMocks();
  rolloutState = "not_live";
  jest.mocked(apiJson).mockResolvedValue({});
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => "12345678-1234-4234-8234-123456789abc" });
});

it("approves the exact return on screen without dispatching it", async () => {
  open(supplierReturn());
  expect(screen.queryByRole("button", { name: /complete/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const [url, options] = jest.mocked(apiJson).mock.calls[0]!;
  expect(url).toBe("/returns/ret-1/approve");
  expect(JSON.parse(options!.body as string)).toEqual({ approvalId: "12345678-1234-4234-8234-123456789abc", ...review });
});

it("dispatches against the displayed approval where the branch still works without the desktop POS", async () => {
  open(supplierReturn({ status: "awaiting_logistics", executionApprovalId: "approval-1" }));
  fireEvent.click(screen.getByRole("button", { name: /Dispatch & complete/ }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
  const [url, options] = jest.mocked(apiJson).mock.calls[0]!;
  expect(url).toBe("/returns/ret-1/complete");
  expect(JSON.parse(options!.body as string)).toEqual({ approvalId: "approval-1" });
});

it.each<PosRolloutState | null>(["live", "fallback", null])("hands dispatch to the counter when the branch is %s", (state) => {
  rolloutState = state;
  open(supplierReturn({ status: "awaiting_logistics", executionApprovalId: "approval-1" }));
  expect(screen.queryByRole("button", { name: /Dispatch & complete/ })).toBeNull();
  expect(screen.getByText("Approved — waiting at the counter")).toBeInTheDocument();
  expect(screen.getByText("Main branch")).toBeInTheDocument();
});

it("asks for a fresh approval when an approved return has no usable evidence", () => {
  open(supplierReturn({ status: "awaiting_logistics", executionApprovalId: null }));
  expect(screen.getByRole("button", { name: "Approve again" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Dispatch & complete/ })).toBeNull();
});
