import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { COUNTER_ALERT_TYPES, defaultCounterAlertPolicy } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import CounterAlertsSettingsPage from "./page";

let permissionKeys = ["tenant.management"];
jest.mock("@/lib/permissions", () => ({ usePermissions: () => ({ permissionKeys }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

const roles = [
  { key: "owner", name: "Owner", isSystem: true },
  { key: "manager", name: "Manager", isSystem: true },
  { key: "shift-lead", name: "Shift lead", isSystem: false },
];

beforeEach(() => {
  permissionKeys = ["tenant.management"];
  (apiJson as jest.Mock).mockReset();
  (apiJson as jest.Mock).mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith("approval-roles") ? roles : { version: 2, policy: defaultCounterAlertPolicy() },
    ),
  );
});

it("lists every counter alert type with owners and managers as default recipients", async () => {
  render(<CounterAlertsSettingsPage />);
  expect(await screen.findByText("Counter offline")).toBeInTheDocument();
  expect(screen.getAllByRole("switch")).toHaveLength(COUNTER_ALERT_TYPES.length);
  const group = screen.getByRole("group", { name: "Counter offline recipients" });
  expect(within(group).getByRole("button", { name: "Owner" })).toHaveAttribute("aria-pressed", "true");
  expect(within(group).getByRole("button", { name: "Shift lead" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("saves the loaded version with a custom role added and an alert switched off", async () => {
  render(<CounterAlertsSettingsPage />);
  const group = await screen.findByRole("group", { name: "Counter offline recipients" });
  fireEvent.click(within(group).getByRole("button", { name: "Shift lead" }));
  fireEvent.click(screen.getByRole("switch", { name: "Send incident note alerts" }));
  fireEvent.click(screen.getByRole("button", { name: "Save counter alerts" }));
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(
      "/tenant/settings/counter-alerts",
      expect.objectContaining({ method: "PUT" }),
    ),
  );
  const put = (apiJson as jest.Mock).mock.calls.find((c) => c[1]?.method === "PUT");
  const body = JSON.parse(put[1].body);
  expect(body.expectedVersion).toBe(2);
  expect(body.policy.rules[0]).toEqual({
    type: "counter_offline",
    enabled: true,
    recipientRoleKeys: ["manager", "owner", "shift-lead"],
  });
  expect(body.policy.rules.find((r: { type: string }) => r.type === "incident_note").enabled).toBe(
    false,
  );
});

it("won't save an alert that is on with nobody to receive it", async () => {
  render(<CounterAlertsSettingsPage />);
  const group = await screen.findByRole("group", { name: "Counter offline recipients" });
  fireEvent.click(within(group).getByRole("button", { name: "Owner" }));
  fireEvent.click(within(group).getByRole("button", { name: "Manager" }));
  fireEvent.click(screen.getByRole("button", { name: "Save counter alerts" }));
  expect(await screen.findByText(/Choose who gets "Counter offline"/)).toBeInTheDocument();
  expect((apiJson as jest.Mock).mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
});

it("is read-only without settings access", async () => {
  permissionKeys = [];
  render(<CounterAlertsSettingsPage />);
  expect((await screen.findAllByRole("switch"))[0]).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save counter alerts" })).not.toBeInTheDocument();
});
