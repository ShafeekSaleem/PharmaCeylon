import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { defaultCounterPolicy } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { CounterPolicyCard } from "./counter-policy-card";

let branchId: string | null = "branch-a";
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
const view = {
  branchId: "branch-a",
  branchName: "Colombo",
  version: 4,
  policy: defaultCounterPolicy(),
  canEdit: true,
};

beforeEach(() => {
  branchId = "branch-a";
  (apiJson as jest.Mock).mockReset();
  (apiJson as jest.Mock).mockResolvedValue(view);
});

it("shows safe disabled defaults and explains future sync and fixed restrictions", async () => {
  render(<CounterPolicyCard />);
  expect(
    await screen.findByRole("switch", {
      name: "Allow offline selling for this branch",
    }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("switch", {
      name: "Allow approved external card payments offline",
    }),
  ).toBeDisabled();
  expect(
    screen.getByText(/Desktop offline trading is not available yet/),
  ).toBeInTheDocument();
  expect(screen.getByText(/cannot instantly revoke/)).toBeInTheDocument();
  expect(screen.getByText(/24 hours/)).toHaveTextContent(/15 minutes/);
});

it("saves the branch and loaded version with normalized merchant identifiers", async () => {
  render(<CounterPolicyCard />);
  fireEvent.click(
    await screen.findByRole("switch", {
      name: "Allow offline selling for this branch",
    }),
  );
  fireEvent.click(
    screen.getByRole("switch", {
      name: "Allow approved external card payments offline",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add card merchant" }));
  fireEvent.change(screen.getByLabelText("Provider 1"), {
    target: { value: " Bank " },
  });
  fireEvent.change(screen.getByLabelText("Merchant ID 1"), {
    target: { value: " MID-1 " },
  });
  (apiJson as jest.Mock).mockResolvedValue({ ...view, version: 5 });
  fireEvent.click(screen.getByRole("button", { name: "Save offline policy" }));
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(
      "/tenant/branches/branch-a/counter-policy",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: 4,
          policy: {
            schemaVersion: 1,
            offlineEnabled: true,
            offlineExternalCardEnabled: true,
            externalCardMerchants: [{ provider: "Bank", merchantId: "MID-1" }],
          },
        }),
      }),
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Counter policy saved",
  );
});

it("disabling offline also disables the card switch in the saved policy", async () => {
  (apiJson as jest.Mock).mockResolvedValue({
    ...view,
    policy: {
      ...defaultCounterPolicy(),
      offlineEnabled: true,
      offlineExternalCardEnabled: true,
      externalCardMerchants: [{ provider: "Bank", merchantId: "1" }],
    },
  });
  render(<CounterPolicyCard />);
  fireEvent.click(
    await screen.findByRole("switch", {
      name: "Allow offline selling for this branch",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save offline policy" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
  const body = JSON.parse((apiJson as jest.Mock).mock.calls[1][1].body);
  expect(body.policy).toMatchObject({
    offlineEnabled: false,
    offlineExternalCardEnabled: false,
  });
});

it("shows a stale-version refusal without reporting success", async () => {
  render(<CounterPolicyCard />);
  await screen.findByRole("switch", {
    name: "Allow offline selling for this branch",
  });
  (apiJson as jest.Mock).mockRejectedValue(
    new Error("Counter settings changed. Reload them before saving again."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save offline policy" }));
  expect(
    await screen.findByText(/Counter settings changed/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("discards branch A's unsaved policy and ignores its delayed read after switching to B", async () => {
  let finishA!: (value: unknown) => void;
  (apiJson as jest.Mock).mockImplementation((path: string) =>
    path.includes("branch-a")
      ? new Promise((resolve) => {
          finishA = resolve;
        })
      : Promise.resolve({
          ...view,
          branchId: "branch-b",
          branchName: "Galle",
          version: 2,
        }),
  );
  const { rerender } = render(<CounterPolicyCard />);
  branchId = "branch-b";
  rerender(<CounterPolicyCard />);
  await screen.findByText("Offline policy — Galle");
  await act(async () =>
    finishA({
      ...view,
      policy: { ...defaultCounterPolicy(), offlineEnabled: true },
    }),
  );
  expect(screen.getByText("Offline policy — Galle")).toBeInTheDocument();
  expect(
    screen.getByRole("switch", {
      name: "Allow offline selling for this branch",
    }),
  ).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save offline policy" }));
  await waitFor(() =>
    expect(apiJson).toHaveBeenLastCalledWith(
      "/tenant/branches/branch-b/counter-policy",
      expect.objectContaining({ method: "PUT" }),
    ),
  );
});

it("requires a branch and never saves without settings access", async () => {
  branchId = null;
  const { rerender } = render(<CounterPolicyCard />);
  expect(screen.getByText(/Choose a branch/)).toBeInTheDocument();
  expect(apiJson).not.toHaveBeenCalled();
  branchId = "branch-a";
  (apiJson as jest.Mock).mockResolvedValue({ ...view, canEdit: false });
  rerender(<CounterPolicyCard />);
  expect(
    await screen.findByRole("switch", {
      name: "Allow offline selling for this branch",
    }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save offline policy" }),
  ).not.toBeInTheDocument();
});
