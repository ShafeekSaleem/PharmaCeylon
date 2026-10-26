import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BranchHoursView } from "@pharmaceylon/shared";
import {
  approveHoursExtension,
  fetchBranchHours,
  fetchHolidaySuggestions,
  revokeHoursExtension,
} from "../hours-api";
import BranchHoursPage from "./page";

let roles: Array<{ branchId: string; role: string }> = [];
let keys: string[] = [];
jest.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("branch=branch-1") }));
jest.mock("@/lib/page-chrome-context", () => ({ usePageChrome: () => ({ setLastSegmentLabel: jest.fn() }) }));
jest.mock("@/lib/permissions", () => ({ usePermissions: () => ({ permissionKeys: keys }) }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ user: { branchRoles: roles } }) }));
jest.mock("../hours-api", () => ({
  fetchBranchHours: jest.fn(),
  fetchHolidaySuggestions: jest.fn(),
  saveBranchHours: jest.fn(),
  approveHoursExtension: jest.fn(),
  revokeHoursExtension: jest.fn(),
}));

const open = { mode: "hours", ranges: [{ opens: "08:00", closes: "20:00" }] } as const;
const loaded: BranchHoursView = {
  branchId: "branch-1",
  branchName: "Colombo 03",
  timezone: "Asia/Colombo",
  version: 2,
  hours: {
    schemaVersion: 1,
    weekly: { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: { mode: "closed" } },
    exceptions: [],
    mandatory: null,
  },
  origin: "editor",
  updatedAt: null,
  updatedBy: null,
  legacyText: null,
  extensions: [
    {
      id: "ext-1",
      startsAt: "2099-10-31T14:30:00.000Z",
      endsAt: "2099-10-31T17:30:00.000Z",
      reason: "Festival night",
      approvedBy: { id: "u1", name: "Nimal Perera" },
      approvedAt: "2099-10-01T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  roles = [{ branchId: "branch-1", role: "manager" }];
  keys = ["tenant.branches_view", "tenant.branches_manage"];
  (fetchBranchHours as jest.Mock).mockResolvedValue(loaded);
  (fetchHolidaySuggestions as jest.Mock).mockResolvedValue({ source: null, holidays: [] });
  (approveHoursExtension as jest.Mock).mockResolvedValue(loaded);
  (revokeHoursExtension as jest.Mock).mockResolvedValue({ ...loaded, extensions: [] });
});

it("lets the branch's manager edit routine hours, with mandatory limits left to the owner", async () => {
  render(<BranchHoursPage />);
  expect(await screen.findByRole("heading", { name: "Opening hours — Colombo 03" })).toBeInTheDocument();
  expect(fetchBranchHours).toHaveBeenCalledWith("branch-1");
  expect(screen.getByRole("combobox", { name: "Monday" })).toBeEnabled();
  expect(screen.getByRole("radio", { name: /No mandatory limit/ })).toBeDisabled();
  expect(screen.getByText("Only the owner can change mandatory selling limits.")).toBeInTheDocument();
});

it("lets the owner change mandatory limits on any branch", async () => {
  roles = [{ branchId: "elsewhere", role: "owner" }];
  render(<BranchHoursPage />);
  expect(await screen.findByRole("radio", { name: /No mandatory limit/ })).toBeEnabled();
});

it("is read-only for a manager of another branch", async () => {
  roles = [{ branchId: "elsewhere", role: "manager" }];
  render(<BranchHoursPage />);
  expect(await screen.findByRole("combobox", { name: "Monday" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save hours" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve extension" })).not.toBeInTheDocument();
});

it("approves an extension in the branch's time, with its reason", async () => {
  render(<BranchHoursPage />);
  expect(await screen.findByText(/Festival night · approved by Nimal Perera/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2099-11-01T20:00" } });
  fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2099-11-01T23:30" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Deepavali" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve extension" }));

  await waitFor(() =>
    expect(approveHoursExtension).toHaveBeenCalledWith("branch-1", {
      // 20:00 in Colombo (+05:30) is 14:30 UTC.
      startsAt: "2099-11-01T14:30:00.000Z",
      endsAt: "2099-11-01T18:00:00.000Z",
      reason: "Deepavali",
    }),
  );
});

it("revokes an extension only with a reason", async () => {
  render(<BranchHoursPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Revoke" });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Cancelled" } });
  fireEvent.click(confirm);
  await waitFor(() => expect(revokeHoursExtension).toHaveBeenCalledWith("branch-1", "ext-1", "Cancelled"));
  expect(await screen.findByText("No upcoming extensions.")).toBeInTheDocument();
});

it("keeps unsaved hour edits when an extension is approved", async () => {
  (approveHoursExtension as jest.Mock).mockResolvedValue({ ...loaded, version: 3 });
  render(<BranchHoursPage />);
  fireEvent.change(await screen.findByRole("combobox", { name: "Sunday" }), { target: { value: "open_24h" } });
  fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2099-11-01T20:00" } });
  fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2099-11-01T23:30" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Deepavali" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve extension" }));
  await waitFor(() => expect(approveHoursExtension).toHaveBeenCalled());
  expect(screen.getByRole("combobox", { name: "Sunday" })).toHaveValue("open_24h");
});
