import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CounterMismatchReport } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { CounterMismatchNotes } from "./counter-mismatch-notes";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

function report(over: Partial<CounterMismatchReport> = {}): CounterMismatchReport {
  return {
    id: "r1", kind: "prepared_receipt", documentId: "pr-1", reference: "PO-1", approvalId: "ev", documentVersion: 3,
    line: { index: 0 }, lineLabel: "Augmentin 625mg", problem: "fewer_arrived", countedQty: 8, countUnit: "packs",
    note: "2 packs come Monday", status: "open", holding: true,
    reported: { name: "Sachini R.", at: "2026-11-20T08:00:00.000Z" }, dismissed: null, dismissNote: null, ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

it("shows what the counter found and keeps the document as approved with a note", async () => {
  const onAnswered = jest.fn();
  jest.mocked(apiJson).mockResolvedValueOnce([report()]).mockResolvedValueOnce({}).mockResolvedValueOnce([]);
  render(<CounterMismatchNotes kind="prepared_receipt" documentId="pr-1" canAnswer onAnswered={onAnswered} />);
  expect(await screen.findByText("Augmentin 625mg · Fewer arrived: 8 packs")).toBeTruthy();
  expect(screen.getByText(/2 packs come Monday/)).toBeTruthy();
  expect(jest.mocked(apiJson).mock.calls[0]![0]).toBe("/counter-work/mismatches?kind=prepared_receipt&documentId=pr-1");

  fireEvent.change(screen.getByLabelText("Note for the counter"), { target: { value: "Post the 8; credit note asked" } });
  fireEvent.click(screen.getByRole("button", { name: "Keep as approved" }));
  await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  const [url, init] = jest.mocked(apiJson).mock.calls[1]!;
  expect(url).toBe("/counter-work/mismatches/r1/dismiss");
  expect(JSON.parse(String(init!.body))).toEqual({ note: "Post the 8; credit note asked" });
});

it("shows nothing for reports a corrected approval replaced, and no answer without approve rights", async () => {
  jest.mocked(apiJson).mockResolvedValueOnce([report({ holding: false })]);
  const { container } = render(<CounterMismatchNotes kind="prepared_receipt" documentId="pr-1" canAnswer />);
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  expect(container.textContent).toBe("");

  jest.mocked(apiJson).mockResolvedValueOnce([report({ kind: "transfer_receive", holding: false, countUnit: "units",
    line: { transferItemId: "i1" } })]);
  render(<CounterMismatchNotes kind="transfer_receive" documentId="t1" canAnswer={false} />);
  expect(await screen.findByText(/can still receive what arrived/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
});
