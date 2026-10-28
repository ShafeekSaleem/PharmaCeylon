import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { defaultCounterPolicy } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { OfflinePolicyCard } from "../offline-policy/offline-policy-card";
import { OfflineManagersCard } from "../offline-policy/offline-managers-card";
import { PaymentsCard } from "../payments/payments-card";
import { RegisterNumberingCard } from "../main/register-numbering-card";
import OfflinePolicySettingsPage from "../offline-policy/page";

let branchId: string | null = "branch-a";
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const reg1 = "11111111-1111-4111-8111-111111111111";
const reg2 = "22222222-2222-4222-8222-222222222222";
const view = {
  branchId: "branch-a",
  branchName: "Colombo",
  version: 4,
  policy: defaultCounterPolicy(),
  registers: [] as { registerId: string; label: string; isActive: boolean }[],
  canEdit: true,
};
const offlineSwitch = { name: "Allow offline selling for this branch" };
const cardSwitch = { name: "Allow approved external card payments offline" };

function lastBody() {
  const calls = (apiJson as jest.Mock).mock.calls.filter((c) => c[1]?.method === "PUT");
  return JSON.parse(calls[calls.length - 1][1].body);
}
const puts = () => (apiJson as jest.Mock).mock.calls.filter((c) => c[1]?.method === "PUT").length;
/** Answers each endpoint the pages read; the counter policy document from `policyView`. */
function route(policyView: unknown, extra: Record<string, unknown> = {}) {
  (apiJson as jest.Mock).mockImplementation((path: string, init?: { method?: string }) => {
    if (path in extra && !init?.method) return Promise.resolve(extra[path]);
    return Promise.resolve(policyView);
  });
}

beforeEach(() => {
  branchId = "branch-a";
  (apiJson as jest.Mock).mockReset();
  (apiJson as jest.Mock).mockResolvedValue(view);
});

describe("offline policy", () => {
  it("shows safe disabled defaults, the fixed rules read-only and the sync wording", async () => {
    render(<OfflinePolicyCard />);
    expect(await screen.findByRole("switch", offlineSwitch)).not.toBeChecked();
    expect(screen.getByText(/Desktop offline trading is not available yet/)).toBeInTheDocument();
    expect(screen.getByText(/Applies to counters after their next sync/)).toBeInTheDocument();
    expect(screen.getByText(/instantly revoke/)).toBeInTheDocument();
    expect(screen.getByText("Offline permission lasts 24 hours")).toBeInTheDocument();
    expect(screen.getByText("Stock at most 15 minutes old")).toBeInTheDocument();
    expect(screen.getByText("Ordinary items only")).toBeInTheDocument();
    expect(screen.getAllByText("Fixed")).toHaveLength(4);
    // Nothing on the page offers or implies web checkout.
    expect(screen.queryByText(/web POS|POS \/ Checkout/i)).not.toBeInTheDocument();
  });

  it("turning offline off also turns off external card in the saved document", async () => {
    (apiJson as jest.Mock).mockResolvedValue({
      ...view,
      policy: {
        ...defaultCounterPolicy(),
        offlineEnabled: true,
        offlineExternalCardEnabled: true,
        externalCardMerchants: [{ provider: "Bank", merchantId: "1" }],
      },
    });
    render(<OfflinePolicyCard />);
    fireEvent.click(await screen.findByRole("switch", offlineSwitch));
    fireEvent.click(screen.getByRole("button", { name: "Save offline policy" }));
    await waitFor(() => expect(puts()).toBe(1));
    expect(lastBody()).toMatchObject({
      expectedVersion: 4,
      policy: { offlineEnabled: false, offlineExternalCardEnabled: false },
    });
  });

  it("shows a stale-version refusal without reporting success", async () => {
    render(<OfflinePolicyCard />);
    await screen.findByRole("switch", offlineSwitch);
    (apiJson as jest.Mock).mockRejectedValue(
      new Error("Counter settings changed. Reload them before saving again."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save offline policy" }));
    expect(await screen.findByText(/Counter settings changed/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("discards branch A's unsaved policy and ignores its delayed read after switching to B", async () => {
    let finishA!: (value: unknown) => void;
    (apiJson as jest.Mock).mockImplementation((path: string) =>
      path.includes("branch-a")
        ? new Promise((resolve) => {
            finishA = resolve;
          })
        : Promise.resolve({ ...view, branchId: "branch-b", branchName: "Galle", version: 2 }),
    );
    const { rerender } = render(<OfflinePolicyCard />);
    branchId = "branch-b";
    rerender(<OfflinePolicyCard />);
    await screen.findByText("Offline selling — Galle");
    await act(async () =>
      finishA({ ...view, policy: { ...defaultCounterPolicy(), offlineEnabled: true } }),
    );
    expect(screen.getByRole("switch", offlineSwitch)).not.toBeChecked();
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
    const { rerender } = render(<OfflinePolicyCard />);
    expect(screen.getByText(/Choose a branch/)).toBeInTheDocument();
    expect(apiJson).not.toHaveBeenCalled();
    branchId = "branch-a";
    (apiJson as jest.Mock).mockResolvedValue({ ...view, canEdit: false });
    rerender(<OfflinePolicyCard />);
    expect(await screen.findByRole("switch", offlineSwitch)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save offline policy" })).not.toBeInTheDocument();
  });

  it("re-reads the offline managers after the policy on the same page saves", async () => {
    const managers = (offlineEnabled: boolean) => ({ offlineEnabled, offlineManagers: [] });
    let enabled = false;
    (apiJson as jest.Mock).mockImplementation((path: string, init?: { method?: string }) => {
      if (path.endsWith("/counter-settings")) return Promise.resolve(managers(enabled));
      if (init?.method === "PUT") {
        enabled = true;
        return Promise.resolve({ ...view, version: 5, policy: { ...defaultCounterPolicy(), offlineEnabled: true } });
      }
      return Promise.resolve(view);
    });
    render(<OfflinePolicySettingsPage />);
    expect(await screen.findByText(/Offline selling is off at this branch/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", offlineSwitch));
    fireEvent.click(screen.getByRole("button", { name: "Save offline policy" }));
    await waitFor(() =>
      expect(screen.queryByText(/Offline selling is off at this branch/)).not.toBeInTheDocument(),
    );
    expect(
      (apiJson as jest.Mock).mock.calls.filter((c) => String(c[0]).endsWith("/counter-settings")),
    ).toHaveLength(2);
  });

  it("lists who holds the offline manager permissions at the branch", async () => {
    (apiJson as jest.Mock).mockResolvedValue({
      offlineManagers: [
        {
          userId: "u1",
          name: "Mala",
          offlineManagerActions: ["acknowledge_business_hours", "assist_shift_handover"],
        },
      ],
    });
    render(<OfflineManagersCard />);
    expect(await screen.findByText("Mala")).toBeInTheDocument();
    expect(screen.getByText("After-hours selling · Shift handover")).toBeInTheDocument();
    expect(apiJson).toHaveBeenCalledWith("/tenant/branches/branch-a/counter-settings");
  });
});

describe("payments", () => {
  it("keeps cash always on and saves online methods with normalized card merchants", async () => {
    (apiJson as jest.Mock).mockResolvedValue({
      ...view,
      policy: { ...defaultCounterPolicy(), offlineEnabled: true },
    });
    render(<PaymentsCard />);
    expect(await screen.findByText("Always on")).toBeInTheDocument();
    expect(screen.getByText(/Applies to counters after their next sync/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Accept customer credit online" }));
    fireEvent.click(screen.getByRole("switch", cardSwitch));
    fireEvent.click(screen.getByRole("button", { name: "Add card merchant" }));
    fireEvent.change(screen.getByLabelText("Provider 1"), { target: { value: " Bank " } });
    fireEvent.change(screen.getByLabelText("Merchant ID 1"), { target: { value: " MID-1 " } });
    (apiJson as jest.Mock).mockResolvedValue({ ...view, version: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Save payments" }));
    await waitFor(() => expect(puts()).toBe(1));
    expect(lastBody()).toEqual({
      expectedVersion: 4,
      policy: {
        ...defaultCounterPolicy(),
        onlinePaymentMethods: ["card", "mobile_wallet"],
        offlineEnabled: true,
        offlineExternalCardEnabled: true,
        externalCardMerchants: [{ provider: "Bank", merchantId: "MID-1" }],
      },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("says when a branch's counters fall back to cash from the tenant default", async () => {
    route(
      { ...view, policy: { ...defaultCounterPolicy(), onlinePaymentMethods: ["mobile_wallet"] } },
      { "/tenant/settings": { posDefaultPaymentMethod: "card" } },
    );
    render(<PaymentsCard />);
    expect(await screen.findByText(/start on cash instead/)).toHaveTextContent(
      "Counters & receipts: Card.",
    );
    // Turning card on removes the fallback.
    fireEvent.click(screen.getByRole("switch", { name: "Accept card online" }));
    await waitFor(() => expect(screen.queryByText(/start on cash instead/)).not.toBeInTheDocument());
  });

  it("can't turn on external card while the branch doesn't sell offline", async () => {
    render(<PaymentsCard />);
    expect(await screen.findByRole("switch", cardSwitch)).toBeDisabled();
    expect(screen.getByText(/Offline selling is off for this branch/)).toBeInTheDocument();
  });
});

describe("register numbering", () => {
  it("saves uppercase prefixes per register and keeps retired registers read-only", async () => {
    (apiJson as jest.Mock).mockResolvedValue({
      ...view,
      registers: [
        { registerId: reg1, label: "Front", isActive: true },
        { registerId: reg2, label: "Old till", isActive: false },
      ],
      policy: {
        ...defaultCounterPolicy(),
        registerNumbering: [{ registerId: reg2, receiptPrefix: "OLD-R", invoicePrefix: "OLD-I" }],
      },
    });
    render(<RegisterNumberingCard />);
    fireEvent.change(await screen.findByLabelText("Front receipt prefix"), {
      target: { value: "c1r-" },
    });
    fireEvent.change(screen.getByLabelText("Front invoice prefix"), { target: { value: "c1i-" } });
    expect(screen.getByLabelText("Old till (retired) receipt prefix")).toBeDisabled();
    expect(screen.getByLabelText("Old till (retired) receipt prefix")).toHaveValue("OLD-R");
    fireEvent.click(screen.getByRole("button", { name: "Save numbering" }));
    await waitFor(() => expect(puts()).toBe(1));
    expect(lastBody().policy.registerNumbering).toEqual([
      { registerId: reg2, receiptPrefix: "OLD-R", invoicePrefix: "OLD-I" },
      { registerId: reg1, receiptPrefix: "C1R-", invoicePrefix: "C1I-" },
    ]);
  });

  it("refuses overlapping series before sending anything", async () => {
    (apiJson as jest.Mock).mockResolvedValue({
      ...view,
      registers: [{ registerId: reg1, label: "Front", isActive: true }],
    });
    render(<RegisterNumberingCard />);
    fireEvent.change(await screen.findByLabelText("Front receipt prefix"), {
      target: { value: "INV-1" },
    });
    fireEvent.change(screen.getByLabelText("Front invoice prefix"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save numbering" }));
    expect(await screen.findByText(/overlaps the online invoice series/)).toBeInTheDocument();
    expect(puts()).toBe(0);
  });

  it("names the register and the missing field when only one prefix is filled", async () => {
    route({ ...view, registers: [{ registerId: reg1, label: "Front", isActive: true }] });
    render(<RegisterNumberingCard />);
    fireEvent.change(await screen.findByLabelText("Front receipt prefix"), {
      target: { value: "C1R-" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save numbering" }));
    expect(
      await screen.findByText("Front: fill in the invoice prefix too, or clear both to leave it unnumbered."),
    ).toBeInTheDocument();
    expect(puts()).toBe(0);
  });

  it("says when the branch has no registers yet", async () => {
    render(<RegisterNumberingCard />);
    expect(await screen.findByText(/no registers yet/)).toBeInTheDocument();
  });
});
