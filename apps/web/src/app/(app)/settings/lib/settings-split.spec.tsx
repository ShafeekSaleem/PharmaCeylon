import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { redirect } from "next/navigation";
import { CounterDefaultsCard } from "../counters/counter-defaults-card";
import { DefaultPaymentCard } from "../payments/default-payment-card";
import { ReceiptCard } from "../receipts/receipt-card";
import MainSettingsRedirectPage from "../main/page";
import OfflinePolicyRedirectPage from "../offline-policy/page";
import { fetchTenantSettings, savePosSettings, saveReceiptSettings } from "./tenant-settings";

/**
 * "Counters & receipts" split into Counters, Receipts and Payments (UI1 #205). Each card now
 * lives on its own page and saves only its own fields, and the old routes redirect.
 */

jest.mock("next/navigation", () => ({ redirect: jest.fn() }));
let grantedKeys = ["tenant.management"];
jest.mock("@/lib/permissions", () => ({
  usePermissions: () => ({ permissionKeys: grantedKeys }),
}));
jest.mock("./tenant-settings", () => ({
  fetchTenantSettings: jest.fn(),
  savePosSettings: jest.fn(),
  saveReceiptSettings: jest.fn(),
}));
// The counter policy section reads the branch; these cards don't use it.
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "b-1" }) }));

const settings = {
  posQuickAddEnabled: true,
  posHeldSalesEnabled: true,
  posRequireCustomer: false,
  posAutoPrintReceipt: false,
  posDefaultPaymentMethod: "cash",
  posMaxDiscountPercent: 10,
  receiptPaperSize: "80mm",
  receiptHeaderText: "Welcome",
  receiptFooterText: null,
  receiptShowLogo: true,
  receiptShowVatBreakdown: true,
  receiptShowStaffName: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  grantedKeys = ["tenant.management"];
  (fetchTenantSettings as jest.Mock).mockResolvedValue(settings);
  (savePosSettings as jest.Mock).mockImplementation(async (dto) => ({
    ...settings,
    ...dto,
  }));
  (saveReceiptSettings as jest.Mock).mockImplementation(async (dto) => ({
    ...settings,
    ...dto,
  }));
});

describe("Counters › How every counter sells", () => {
  it("saves only the counter fields, not the default payment method or auto-print", async () => {
    render(<CounterDefaultsCard />);
    fireEvent.click(await screen.findByRole("switch", { name: "Held sales" }));
    fireEvent.change(screen.getByLabelText("Max discount without approval (%)"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savePosSettings).toHaveBeenCalledTimes(1));
    expect(savePosSettings).toHaveBeenCalledWith({
      posQuickAddEnabled: true,
      posHeldSalesEnabled: false,
      posRequireCustomer: false,
      posMaxDiscountPercent: 15,
    });
  });

  it("is read-only without tenant management", async () => {
    grantedKeys = [];
    render(<CounterDefaultsCard />);
    expect(await screen.findByLabelText("Max discount without approval (%)")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });
});

describe("Receipts › Printed receipt", () => {
  it("saves the receipt fields and leaves auto-print alone when it didn't change", async () => {
    render(<ReceiptCard />);
    fireEvent.change(await screen.findByLabelText("Footer text"), {
      target: { value: "Get well soon" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveReceiptSettings).toHaveBeenCalledTimes(1));
    expect(saveReceiptSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptFooterText: "Get well soon",
        receiptPaperSize: "80mm",
      }),
    );
    expect(savePosSettings).not.toHaveBeenCalled();
  });

  it("sends auto-print on its own when it changed", async () => {
    render(<ReceiptCard />);
    fireEvent.click(
      await screen.findByRole("switch", {
        name: "Print the receipt after every sale",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savePosSettings).toHaveBeenCalledTimes(1));
    expect(savePosSettings).toHaveBeenCalledWith({ posAutoPrintReceipt: true });
  });

  it("says why it is empty when settings can't be read", async () => {
    (fetchTenantSettings as jest.Mock).mockRejectedValue(new Error("Network down"));
    render(<ReceiptCard />);
    expect(await screen.findByText("Network down")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});

describe("Payments › Default payment method", () => {
  it("saves the default and tells the page so the branch note can re-read it", async () => {
    const onSaved = jest.fn();
    render(<DefaultPaymentCard onSaved={onSaved} />);
    fireEvent.click(await screen.findByLabelText("Default payment method"));
    fireEvent.mouseDown(screen.getByRole("option", { name: "Card" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(savePosSettings).toHaveBeenCalledWith({
      posDefaultPaymentMethod: "card",
    });
  });
});

describe("old routes", () => {
  it("send Counters & receipts to Counters and Offline policy to Offline selling", () => {
    MainSettingsRedirectPage();
    expect(redirect).toHaveBeenLastCalledWith("/settings/counters");
    OfflinePolicyRedirectPage();
    expect(redirect).toHaveBeenLastCalledWith("/settings/offline-selling");
  });
});
