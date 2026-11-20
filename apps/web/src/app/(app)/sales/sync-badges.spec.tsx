import { render, screen } from "@testing-library/react";
import {
  clearsOnUploadBadge,
  incidentNoteStatusBadge,
  offlineSyncBadge,
  saleStatusBadge,
  unresolvedMoneyStatusBadge,
} from "./sync-badges";

describe("sale and sync status pills", () => {
  it("renders every sale status as a worded pill", () => {
    const { rerender } = render(saleStatusBadge("posted"));
    expect(screen.getByText("Completed")).toBeInTheDocument();
    rerender(saleStatusBadge("partially_refunded"));
    expect(screen.getByText("Partly refunded")).toBeInTheDocument();
    rerender(saleStatusBadge("refunded"));
    expect(screen.getByText("Refunded")).toBeInTheDocument();
    rerender(saleStatusBadge("voided"));
    expect(screen.getByText("Voided")).toBeInTheDocument();
  });

  it("renders every offline sync state pill", () => {
    const { rerender } = render(<>{offlineSyncBadge("accepted", "list")}</>);
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    rerender(<>{offlineSyncBadge("pending_stock_posting", "list")}</>);
    expect(screen.getByText("Pending stock")).toBeInTheDocument();
    rerender(<>{offlineSyncBadge("pending_stock_posting", "detail")}</>);
    expect(screen.getByText("Pending stock posting")).toBeInTheDocument();
    rerender(<>{offlineSyncBadge("held", "list")}</>);
    expect(screen.getByText("Held")).toBeInTheDocument();
    expect(screen.queryByText("Pending stock")).not.toBeInTheDocument();
  });

  it("renders queue status pills", () => {
    const { rerender } = render(incidentNoteStatusBadge("accepted"));
    expect(screen.getByText("Open")).toBeInTheDocument();
    rerender(incidentNoteStatusBadge("held"));
    expect(screen.getByText("Held")).toBeInTheDocument();
    rerender(unresolvedMoneyStatusBadge());
    expect(screen.getByText("Unresolved")).toBeInTheDocument();
    rerender(<>{clearsOnUploadBadge(true)}</>);
    expect(screen.getByText("Clears on upload")).toBeInTheDocument();
  });
});