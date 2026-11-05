import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { OfflineAssignmentView } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { AssignmentDelegationsCard } from "./assignment-delegations-card";
import { eligibleManagers } from "./delegations-api";
import type { AdminUser } from "../../users/types";
import type { RoleRow } from "../../users/roles/types";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
let branchId: string | null = "branch-a";
let owner = true;
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    branchId,
    user: {
      id: "owner",
      branchRoles: [
        { branchId: "branch-a", role: owner ? "owner" : "manager" },
      ],
    },
  }),
}));

const person = (
  id: string,
  role = "manager",
  branch = "branch-a",
  roleId?: string,
): AdminUser => ({
  id,
  fullName: id,
  email: `${id}@example.test`,
  isActive: true,
  createdAt: "2026-11-06",
  userBranchRoles: [
    {
      id: `role-${id}`,
      branchId: branch,
      role: role as "manager",
      roleId,
      roleRef: roleId ? { id: roleId, key: role, name: role } : null,
    },
  ],
});
const role = (
  id: string,
  key: string,
  permissions: string[],
  defaults = permissions,
): RoleRow => ({
  id,
  key,
  name: key,
  permissionKeys: permissions,
  defaultPermissionKeys: defaults,
  description: null,
  isSystem: false,
  isLocked: false,
  backOfficeAccess: true,
  assignedCount: 1,
});
const staff = [
  person("owner", "owner"),
  person("Maya"),
  person("Nimal", "custom", "branch-a", "custom-role"),
  person("Other branch", "manager", "branch-b"),
  person("Cashier", "cashier"),
  { ...person("Inactive"), isActive: false },
];
const roles = [
  role("manager-role", "manager", ["tenant.management"]),
  role("custom-role", "custom", ["tenant.management"]),
  role("cashier-role", "cashier", []),
];
const delegation = {
  delegationId: "delegation-a",
  tenantId: "tenant",
  branchId: "branch-a",
  managerUserId: "Maya",
  delegatedByOwnerUserId: "owner",
  createdAt: Date.UTC(2026, 10, 6),
  revokedAt: null,
};
const view = (
  delegations: OfflineAssignmentView["delegations"] = [],
): OfflineAssignmentView => ({
  branchId: "branch-a",
  nomination: null,
  nominationVersion: 0,
  authorizations: [],
  delegations,
});
let current: OfflineAssignmentView;
beforeEach(() => {
  branchId = "branch-a";
  owner = true;
  current = view();
  (apiJson as jest.Mock)
    .mockReset()
    .mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/admin/users") return Promise.resolve(staff);
      if (path === "/admin/roles") return Promise.resolve(roles);
      if (path.endsWith("/revoke")) {
        current = view([{ ...delegation, revokedAt: Date.now() }]);
        return Promise.resolve(current);
      }
      if (init?.method === "POST") {
        current = view([delegation]);
        return Promise.resolve(current);
      }
      return Promise.resolve(current);
    });
});

it("only loads owner controls with a selected branch", async () => {
  owner = false;
  const { rerender } = render(<AssignmentDelegationsCard />);
  expect(apiJson).not.toHaveBeenCalled();
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  owner = true;
  branchId = null;
  rerender(<AssignmentDelegationsCard />);
  expect(screen.getByText(/Select a branch/)).toBeInTheDocument();
  expect(apiJson).not.toHaveBeenCalled();
});

it("offers eligible branch staff including custom roles, excluding owners, inactive and other branches", async () => {
  render(<AssignmentDelegationsCard />);
  const select = await screen.findByRole("combobox", { name: /Staff member/ });
  expect(
    within(select)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual([
    "Choose staff",
    "Maya (Maya@example.test)",
    "Nimal (Nimal@example.test)",
  ]);
  expect(
    screen.getByRole("button", { name: "Grant authority" }),
  ).toBeDisabled();
});

it("uses live linked-role permissions and legacy catalog defaults independently", () => {
  const changed = [
    role("manager-role", "manager", [], ["tenant.management"]),
    role("custom-role", "custom", []),
  ];
  expect(
    eligibleManagers(
      [
        person("legacy"),
        person("linked", "manager", "branch-a", "manager-role"),
        staff[2],
      ],
      changed,
      "branch-a",
    ).map((p) => p.id),
  ).toEqual(["legacy"]);
});

it("grants authority for the selected branch and updates the list without enabling a device", async () => {
  render(<AssignmentDelegationsCard />);
  fireEvent.change(await screen.findByRole("combobox"), {
    target: { value: "Maya" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Grant authority" }));
  expect(
    await screen.findByText("Assignment authority granted for this branch."),
  ).toBeInTheDocument();
  expect(apiJson).toHaveBeenCalledWith(
    "/terminals/offline-assignment/delegations",
    {
      method: "POST",
      headers: { "x-branch-id": "branch-a" },
      body: JSON.stringify({ managerUserId: "Maya" }),
    },
  );
  expect(
    screen.getByRole("button", { name: "Revoke authority for Maya" }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("combobox")).queryByText(/Maya/),
  ).not.toBeInTheDocument();
  expect(
    (apiJson as jest.Mock).mock.calls.filter(
      ([, init]) => init?.method === "POST",
    ),
  ).toHaveLength(1);
});

it("requires a nonblank reason to revoke, explains the consequences and shows history", async () => {
  current = view([delegation]);
  render(<AssignmentDelegationsCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Revoke authority for Maya" }),
  );
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByText(/already activated device is not deactivated/),
  ).toBeInTheDocument();
  const revoke = within(dialog).getByRole("button", {
    name: "Revoke authority",
  });
  expect(revoke).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(/Reason/), {
    target: { value: "   " },
  });
  expect(revoke).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(/Reason/), {
    target: { value: "  Changed responsibilities  " },
  });
  fireEvent.click(revoke);
  expect(
    await screen.findByText("Assignment authority revoked for this branch."),
  ).toBeInTheDocument();
  expect(apiJson).toHaveBeenCalledWith(
    "/terminals/offline-assignment/delegations/delegation-a/revoke",
    {
      method: "POST",
      headers: { "x-branch-id": "branch-a" },
      body: JSON.stringify({ reason: "Changed responsibilities" }),
    },
  );
  expect(screen.getByText("Revoked")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("preserves the revoke reason and open dialog after a server refusal", async () => {
  current = view([delegation]);
  render(<AssignmentDelegationsCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Revoke authority for Maya" }),
  );
  (apiJson as jest.Mock).mockRejectedValueOnce(
    new Error("Live branch authentication required"),
  );
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Leaving" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Revoke authority",
    }),
  );
  expect(
    await screen.findByText("Live branch authentication required"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/Reason/)).toHaveValue("Leaving");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("offers retry after a load failure and keeps the form unavailable until loaded", async () => {
  (apiJson as jest.Mock).mockRejectedValueOnce(new Error("Disconnected"));
  render(<AssignmentDelegationsCard />);
  expect(await screen.findByText("Disconnected")).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("combobox")).toBeInTheDocument();
});

it("ignores a late branch load and pins subsequent requests to the new branch", async () => {
  let resolveOld!: (value: OfflineAssignmentView) => void;
  (apiJson as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const { rerender } = render(<AssignmentDelegationsCard />);
  branchId = "branch-b";
  rerender(<AssignmentDelegationsCard />);
  await screen.findByRole("combobox");
  await act(async () => {
    resolveOld(view([delegation]));
  });
  expect(
    screen.queryByRole("button", { name: "Revoke authority for Maya" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "Other branch" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Grant authority" }));
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(
      "/terminals/offline-assignment/delegations",
      expect.objectContaining({ headers: { "x-branch-id": "branch-b" } }),
    ),
  );
});

it("blocks duplicate submissions and cancellation while a revoke is pending", async () => {
  current = view([delegation]);
  render(<AssignmentDelegationsCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Revoke authority for Maya" }),
  );
  let finish!: (value: OfflineAssignmentView) => void;
  (apiJson as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.change(screen.getByLabelText(/Reason/), {
    target: { value: "Leaving" },
  });
  const confirm = within(screen.getByRole("dialog")).getByRole("button", {
    name: "Revoke authority",
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(confirm).toBeDisabled();
  expect(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
  ).toBeDisabled();
  expect(
    (apiJson as jest.Mock).mock.calls.filter(
      ([, init]) => init?.method === "POST",
    ),
  ).toHaveLength(1);
  await act(async () => {
    finish(view([{ ...delegation, revokedAt: Date.now() }]));
  });
});

it("still lets an owner revoke an ineligible staff member's old grant", async () => {
  current = view([{ ...delegation, managerUserId: "Inactive" }]);
  render(<AssignmentDelegationsCard />);
  expect(await screen.findByText(/Currently ineligible/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Revoke authority for Inactive" }),
  ).toBeEnabled();
});
