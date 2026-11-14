/** @jest-environment jsdom */
import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { PrepareCashPayoutModal } from "./prepare-cash-payout-modal";

jest.mock("../hooks/use-suppliers", () => ({
  useSuppliers: () => ({ rows: [{ id: "s1", name: "Hemas" }], loading: false }),
}));
jest.mock("../hooks/use-ledger", () => ({
  useInvoices: () => ({
    rows: [],
    fresh: true,
    error: null,
    loading: false,
  }),
}));

describe("PrepareCashPayoutModal", () => {
  it("opens with the amount prompt from the spec", () => {
    render(<PrepareCashPayoutModal open onClose={() => undefined} onPrepared={() => undefined} />);
    expect(screen.getByText("Enter the amount to pay out")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Prepare cash payout/i })).toBeTruthy();
  });
});