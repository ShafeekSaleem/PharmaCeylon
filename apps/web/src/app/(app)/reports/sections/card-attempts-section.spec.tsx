import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CardAttemptRow, CardAttemptsReportResponse } from "../lib/types";
import { CardAttemptsSection } from "./card-attempts-section";
import { fetchCardAttemptsReport } from "../lib/fetchers";

jest.mock("../lib/fetchers", () => ({ fetchCardAttemptsReport: jest.fn() }));

const row = (over: Partial<CardAttemptRow>): CardAttemptRow => ({
  attemptId: "a1",
  branchId: "b1",
  branchName: "Kandy",
  terminalId: "t1",
  terminalLabel: "FRONT-PC",
  counterLabel: "Counter 1",
  staff: { id: "u1", name: "Amara" },
  firstRecordedAt: "2026-11-25T03:00:00.000Z",
  lastRecordedAt: "2026-11-25T03:02:00.000Z",
  events: 3,
  state: "linked_to_sale",
  outcome: "charged_sale",
  amountMinor: 250_000,
  providerReference: "RRN1",
  approvalCode: "A12",
  approvedAt: "2026-11-25T03:01:00.000Z",
  sale: { id: "s1", invoiceNo: "C1R-0001" },
  settlement: null,
  reversalReference: null,
  reason: null,
  review: "accepted",
  heldReason: null,
  ...over,
});

const zero = { count: 0, amountMinor: 0 };
const response = (attempts: CardAttemptRow[]): CardAttemptsReportResponse => ({
  days: 30,
  timeZone: "Asia/Colombo",
  since: "2026-10-28T18:30:00.000Z",
  before: "2026-11-27T18:30:00.000Z",
  kpis: {
    attempts: attempts.length,
    amountMinor: 330_000,
    heldForReview: 1,
    chargedWithoutSaleMinor: 80_000,
    collectedNotSold: zero,
    charged_sale: { count: 1, amountMinor: 250_000 },
    declined: zero,
    reversed: zero,
    refund_owed: { count: 1, amountMinor: 80_000 },
    approved_no_sale: zero,
    unresolved: zero,
  },
  byCounter: [{ terminalId: "t1", label: "Counter 1", branchName: "Kandy", attempts: 2, problemAttempts: 1, amountMinor: 330_000 }],
  attempts,
});

const owed = row({
  attemptId: "a2",
  state: "not_used",
  outcome: "refund_owed",
  amountMinor: 80_000,
  sale: null,
  settlement: "refund_owed",
  reason: "Machine offline",
  review: "held",
  heldReason: "card_not_used",
});

describe("CardAttemptsSection", () => {
  beforeEach(() => (fetchCardAttemptsReport as jest.Mock).mockResolvedValue(response([row({}), owed])));

  it("shows card money with no sale behind it and how each attempt ended", async () => {
    render(<CardAttemptsSection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    expect(await screen.findByText("C1R-0001")).toBeInTheDocument();
    expect(screen.getAllByText("Refund owed").length).toBeGreaterThan(0);
    expect(screen.getByText("Machine offline")).toBeInTheDocument();
    expect(screen.getByText("Held")).toBeInTheDocument();
    expect(screen.getByText("1 to look at · 1 held for review")).toBeInTheDocument();
  });

  it("filters to the attempts that need a look", async () => {
    render(<CardAttemptsSection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    await screen.findByText("C1R-0001");
    fireEvent.click(screen.getByRole("button", { name: "Outcome" }));
    fireEvent.click(screen.getByRole("option", { name: "Needs a look" }));
    await waitFor(() => expect(screen.queryByText("C1R-0001")).not.toBeInTheDocument());
    expect(screen.getByText("Machine offline")).toBeInTheDocument();
  });

  it("exports every attempt with its outcome and references", async () => {
    const onExport = jest.fn();
    render(<CardAttemptsSection scope="branch" isOwner={false} days={30} onExportData={onExport} />);
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ filename: "card-attempts-30d.csv" })));
    const payload = onExport.mock.calls.find((c) => c[0])![0];
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows[1]).toEqual(expect.arrayContaining(["Refund owed", "800.00", "refund_owed", "Machine offline", "held"]));
  });

  it("says the report failed rather than showing no attempts", async () => {
    (fetchCardAttemptsReport as jest.Mock).mockRejectedValue(new Error("Forbidden"));
    const { container } = render(<CardAttemptsSection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    await waitFor(() => expect(within(container).getByText("Forbidden")).toBeInTheDocument());
  });
});
