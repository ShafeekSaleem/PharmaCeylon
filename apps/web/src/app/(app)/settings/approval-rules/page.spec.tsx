import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ApprovalRulesPage from "./page";
import {
  fetchApprovalRoles,
  fetchTenantSettings,
  saveApprovalsSettings,
} from "../lib/tenant-settings";

let grantedKeys = ["tenant.management", "tenant.approval_rules"];
jest.mock("@/lib/permissions", () => ({
  usePermissions: () => ({ permissionKeys: grantedKeys, loading: false, hasLoadedOnce: true }),
}));
jest.mock("../lib/tenant-settings", () => ({
  fetchTenantSettings: jest.fn(),
  fetchApprovalRoles: jest.fn(),
  saveApprovalsSettings: jest.fn(),
}));

const settings = {
  approvalRequiredPurchaseOrderThreshold: null,
  approvalRequiredForBranchTransfers: true,
  approvalRequiredReturnThreshold: null,
  selfApprovalRoleKeys: ["owner", "manager"],
};

beforeEach(() => {
  grantedKeys = ["tenant.management", "tenant.approval_rules"];
  (fetchTenantSettings as jest.Mock).mockResolvedValue(settings);
  (fetchApprovalRoles as jest.Mock).mockResolvedValue([
    { key: "owner", name: "Owner", isSystem: true },
    { key: "manager", name: "Manager", isSystem: true },
    { key: "inventory_clerk", name: "Inventory Clerk", isSystem: true },
    { key: "senior_clerk", name: "Senior Clerk", isSystem: false },
  ]);
  (saveApprovalsSettings as jest.Mock).mockImplementation(async (dto) => ({ ...settings, ...dto }));
});

it("lets owners and managers approve their own requests by default, and nobody else", async () => {
  render(<ApprovalRulesPage />);
  expect(await screen.findByRole("switch", { name: "Owner may approve their own requests" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Manager may approve their own requests" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Inventory Clerk may approve their own requests" })).not.toBeChecked();
  expect(screen.getByText(/Custom role/)).toBeInTheDocument();
});

it("saves the roles chosen, including custom roles", async () => {
  render(<ApprovalRulesPage />);
  fireEvent.click(await screen.findByRole("switch", { name: "Manager may approve their own requests" }));
  fireEvent.click(screen.getByRole("switch", { name: "Senior Clerk may approve their own requests" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(saveApprovalsSettings).toHaveBeenCalledWith(
      expect.objectContaining({ selfApprovalRoleKeys: ["owner", "senior_clerk"] }),
    ),
  );
  expect(await screen.findByText("Approval rules saved.")).toBeInTheDocument();
});

it("warns when no role may self-approve", async () => {
  render(<ApprovalRulesPage />);
  fireEvent.click(await screen.findByRole("switch", { name: "Owner may approve their own requests" }));
  fireEvent.click(screen.getByRole("switch", { name: "Manager may approve their own requests" }));
  expect(screen.getByText(/Nobody can approve their own requests/)).toBeInTheDocument();
});

it("leaves the rule read-only for a manager, who is the one it holds to a second approver", async () => {
  grantedKeys = ["tenant.management"];
  render(<ApprovalRulesPage />);
  expect(
    await screen.findByRole("switch", { name: "Manager may approve their own requests" }),
  ).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  expect(screen.getByText(/Only the owner can change this/)).toBeInTheDocument();
});
