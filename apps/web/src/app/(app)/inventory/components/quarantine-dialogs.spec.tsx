import { fireEvent, render, screen } from "@testing-library/react";
import {
  batchQuarantineBoundaryMessage,
  QuarantineDialog,
  ReleaseDialog,
  quarantineTargetFromBatch,
} from "./quarantine-dialogs";
import { ApiError, COUNTER_BOUNDARY_MESSAGES } from "@/lib/api-error";

function target(overrides: Record<string, unknown> = {}) {
  return quarantineTargetFromBatch({
    id: "batch-1",
    batchNo: "B1",
    qtyOnHand: 10,
    quarantinedQty: 0,
    reservedQty: 0,
    expired: false,
    quarantineReason: null,
    product: { name: "Test product" },
    ...overrides,
  });
}

describe("QuarantineDialog", () => {
  it("shows counter-only handoff instead of posting to the browser quarantine route", () => {
    render(<QuarantineDialog target={target()} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Do this at the counter in PharmaCeylon POS.");
    expect(screen.getByRole("status")).toHaveTextContent("Quarantine the stock at this branch.");
    expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the nothing-to-hold message when every unit is already held or reserved", () => {
    render(<QuarantineDialog target={target({ qtyOnHand: 5, quarantinedQty: 3, reservedQty: 2 })} onClose={() => {}} />);
    expect(
      screen.getByText(/Nothing on this batch is available to quarantine/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("ReleaseDialog", () => {
  it("shows counter-only handoff for releasable stock", () => {
    render(
      <ReleaseDialog
        target={target({ quarantinedQty: 4, quarantineReason: "Damaged" })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Held for: Damaged")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Release the stock at this branch.");
    expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
  });

  it("still blocks expired batches from sale release", () => {
    render(<ReleaseDialog target={target({ expired: true, quarantinedQty: 2 })} onClose={() => {}} />);
    expect(screen.getByText(/Expired stock can't go back on sale/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("calls onClose from the footer", () => {
    const onClose = jest.fn();
    render(<ReleaseDialog target={target({ quarantinedQty: 1 })} onClose={onClose} />);
    const footerClose = screen
      .getAllByRole("button", { name: "Close" })
      .find((btn) => btn.className.includes("btnSecondary"));
    fireEvent.click(footerClose!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("batchQuarantineBoundaryMessage", () => {
  it("maps TERMINAL_REQUIRED to the shared counter-boundary copy", () => {
    const err = new ApiError(COUNTER_BOUNDARY_MESSAGES.TERMINAL_REQUIRED, 403, {
      code: "TERMINAL_REQUIRED",
    });
    expect(batchQuarantineBoundaryMessage(err)).toBe(COUNTER_BOUNDARY_MESSAGES.TERMINAL_REQUIRED);
  });
});