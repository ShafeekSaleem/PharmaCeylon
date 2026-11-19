import { render, screen, within } from "@testing-library/react";
import type { StocktakeListItem } from "../types";
import { StocktakeReviewSidebar } from "./stocktake-review-sidebar";

const stocktake = {
  id: "st-1",
  status: "under_review",
  lines: [],
  varianceLineCount: 0,
  varianceUnitsOut: 0,
  varianceUnitsIn: 0,
} as unknown as StocktakeListItem;

it("says each approval step's state in words, not only by dot colour", () => {
  render(
    <StocktakeReviewSidebar
      stocktake={stocktake}
      drafts={{}}
      showExpected
      canEdit={false}
      onExport={() => {}}
      onRequestRecount={() => {}}
      onSaveReview={() => {}}
    />,
  );
  const list = screen.getByText("Approval checklist")
    .nextElementSibling as HTMLElement;
  const steps = within(list).getAllByRole("listitem");
  expect(steps.map((li) => li.lastElementChild?.textContent)).toEqual([
    "Done",
    "Done",
    "Done",
    "Not yet",
  ]);
});
