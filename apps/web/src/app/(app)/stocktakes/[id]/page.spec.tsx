import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import StocktakeDetailPage from "./page";
import { useStocktakeDetail } from "../hooks/use-stocktake-detail";
import { apiJson } from "@/lib/auth-client";
import type { StocktakeListItem } from "../types";

jest.mock("next/navigation", () => ({ useParams: () => ({ id: "count-1" }), useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/page-chrome-context", () => ({ usePageChrome: () => ({ setLastSegmentLabel: jest.fn() }) }));
jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("../hooks/use-stocktake-detail", () => ({ useStocktakeDetail: jest.fn() }));
jest.mock("../components/stocktake-header", () => ({ StocktakeHeader: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div> }));
jest.mock("../components/edit-stocktake-modal", () => ({ EditStocktakeModal: () => null }));
jest.mock("../components/manage-stocktake-lines-modal", () => ({ ManageStocktakeLinesModal: () => null }));
jest.mock("../components/stocktake-count-tab", () => ({ StocktakeCountTab: () => null }));
jest.mock("../components/stocktake-review-tab", () => ({ StocktakeReviewTab: () => null }));
jest.mock("../components/stocktake-activity-tab", () => ({ StocktakeActivityTab: () => null }));
jest.mock("../components/stocktake-details-tab", () => ({ StocktakeDetailsTab: () => null }));
jest.mock("../components/stocktake-review-sidebar", () => ({ StocktakeReviewSidebar: () => null }));
jest.mock("../components/stocktake-summary-sidebar", () => ({ StocktakeSummarySidebar: () => null }));
jest.mock("../components/stocktake-changes-panel", () => ({
  StocktakeChangesPanel: () => null,
  ApproveStocktakeModal: ({ open, mode, onApprove }: { open: boolean; mode?: string; onApprove: () => void }) =>
    open ? <button onClick={onApprove}>{mode === "post" ? "Confirm posting" : "Confirm fresh approval"}</button> : null,
}));

const row = {
  id: "count-1", stocktakeNumber: "ST-001", status: "approved", executionApprovalId: "old-evidence",
  approvalReview: { expectedVersion: 7, expectedDigest: "a".repeat(64) },
  updatedAt: "2026-10-26T00:00:00Z", lines: [], postings: [], assignments: [],
  permissions: { canWrite: true, canReview: true, canApprove: true, canPost: true, canViewExpected: true },
  uncountedLineCount: 0, totalCountedQty: 0, lineCount: 0,
} as unknown as StocktakeListItem;

beforeEach(() => {
  jest.mocked(useStocktakeDetail).mockReturnValue({ data: row, loading: false, error: null,
    reload: jest.fn().mockResolvedValue(row), setData: jest.fn() });
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: () => "new-evidence-id" });
});

it("offers and submits fresh approval after posting rejects removed approver rights", async () => {
  jest.mocked(apiJson).mockRejectedValueOnce(new Error("Approver is no longer authorized"))
    .mockResolvedValueOnce({ ...row, executionApprovalId: "new-evidence-id" });
  render(<StocktakeDetailPage />);
  fireEvent.click(screen.getByRole("button", { name: "Post adjustments" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm posting" }));
  await screen.findByText("Approver is no longer authorized");
  fireEvent.click(screen.getByRole("button", { name: "Review approval" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm fresh approval" }));
  await waitFor(() => expect(apiJson).toHaveBeenCalledWith("/stocktakes/count-1/approve", expect.objectContaining({
    method: "POST", body: JSON.stringify({ approvalId: "new-evidence-id", ...row.approvalReview }),
  })));
});

it("retains the self-approval restriction on replacing existing evidence", () => {
  jest.mocked(useStocktakeDetail).mockReturnValue({ data: { ...row, selfApprovalBlocked: true }, loading: false,
    error: null, reload: jest.fn(), setData: jest.fn() });
  render(<StocktakeDetailPage />);
  expect(screen.getByRole("button", { name: "Review approval" })).toBeDisabled();
});
