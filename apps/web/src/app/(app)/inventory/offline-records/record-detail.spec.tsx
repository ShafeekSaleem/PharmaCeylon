import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import OfflineRecordsRoute from "./page";
import { RecordDetail } from "./record-detail";
import type {
  RefusedRecordDetail,
  RefusedRecordSummary,
  Settlement,
} from "./types";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/permissions", () => ({
  usePermissions: jest.fn(),
  hasPermission: () => true,
}));
jest.mock("@/components/role-access", () => ({
  RolePageGuard: ({ children }: { children: React.ReactNode }) => children,
}));
const replace = jest.fn();
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  useSearchParams: () => mockParams,
  usePathname: () => "/inventory/offline-records",
}));

const manager = { id: "u-manager", name: "Nimal Manager" };
const owner = { id: "u-owner", name: "Owner Perera" };
const cashier = { id: "u-cashier", name: "Dilini Cashier" };

function detail(
  overrides: Partial<RefusedRecordDetail> = {},
): RefusedRecordDetail {
  return {
    id: "review-1",
    state: "open",
    kind: "ordinary_sale",
    counter: { terminalId: "t", enrollmentId: "e", label: "Front" },
    sequence: 7,
    commandId: "cmd",
    recordHash: "a".repeat(64),
    acceptedThroughSequence: 6,
    refusal: {
      code: "GRANT_EXPIRED",
      explanation:
        "Sold after the counter's 24-hour offline permission had run out.",
    },
    attempts: 3,
    firstReceivedAt: "2026-11-10T05:00:00.000Z",
    lastReceivedAt: "2026-11-10T05:02:00.000Z",
    receivedBy: cashier,
    entry: {
      kind: "ordinary_sale",
      occurredAt: "2026-11-10T04:00:00.000Z",
      offlineStartedAt: "2026-11-09T02:00:00.000Z",
      staff: cashier,
      signedInAs: cashier,
      workSessionId: "shift-1",
      shift: {
        number: "S-0004",
        openedAt: "2026-11-09T02:10:00.000Z",
        closedAt: null,
      },
      snapshotVersion: 2,
      totalMinor: 3658,
      lines: [
        {
          snapshotLineId: "l1",
          product: { id: "p", name: "Paracetamol 500mg" },
          batch: { id: "b", batchNo: "PCM-7", expiryDate: "2027-11-01" },
          quantity: 2,
          unitPriceMinor: 1550,
          taxMinor: 558,
          lineTotalMinor: 3658,
          inSnapshot: true,
        },
      ],
      payments: [
        {
          method: "cash",
          amountMinor: 3658,
          tenderedMinor: 4000,
          changeMinor: 342,
        },
      ],
    },
    settleBlocker: null,
    recordable: { ok: true, blocker: null, message: null },
    notHonoured: {
      ok: true,
      message:
        "No sale, payment or stock is recorded. Any cash the counter took shows as that shift's variance.",
    },
    settlements: [],
    ...overrides,
  };
}

function settlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    id: "settlement-1",
    decision: "recorded",
    reason: "Power cut ran past midnight",
    status: "prepared",
    approvalVersion: 1,
    executionApprovalId: null,
    approvalReview: { expectedVersion: 1, expectedDigest: "d".repeat(64) },
    requester: manager,
    requestedAt: "2026-11-10T05:10:00.000Z",
    approver: null,
    approvedAt: null,
    settledAt: null,
    cancelledBy: null,
    cancelledAt: null,
    sale: null,
    workSessionId: null,
    collectedPayments: [],
    ...overrides,
  };
}

function renderDetail(
  d: RefusedRecordDetail,
  opts: { userId?: string; canSelfApprove?: boolean } = {},
) {
  const handlers = {
    onPrepare: jest.fn().mockResolvedValue(true),
    onApprove: jest.fn().mockResolvedValue(true),
    onCancel: jest.fn().mockResolvedValue(true),
  };
  render(
    <RecordDetail
      detail={d}
      busy={false}
      userId={opts.userId ?? "u-owner"}
      canSelfApprove={opts.canSelfApprove ?? true}
      {...handlers}
    />,
  );
  return handlers;
}

let uuids = 0;
beforeEach(() => {
  jest.clearAllMocks();
  mockParams = new URLSearchParams();
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`,
    configurable: true,
  });
});

describe("refused offline records (P5 #51 slice 4)", () => {
  it("shows the record as the counter made it and why it was refused", () => {
    renderDetail(detail());
    expect(
      screen.getByRole("heading", { name: /Offline sale/ }),
    ).toHaveTextContent("Blocking the counter");
    expect(
      screen.getByText(/24-hour offline permission had run out/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Front · record 7/)).toBeInTheDocument();
    expect(screen.getByText(/sent 3 times/)).toBeInTheDocument();
    const receipt = screen.getByRole("table", { name: "Receipt" });
    expect(within(receipt).getByText("Paracetamol 500mg")).toBeInTheDocument();
    expect(within(receipt).getByText("PCM-7")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Cash LKR 36.58 \(tendered LKR 40.00, change LKR 3.42\)/,
      ),
    ).toBeInTheDocument();
  });

  it("prepares a decision only with a reason, recording it by default when it can be", () => {
    const { onPrepare } = renderDetail(detail());
    const prepare = screen.getByRole("button", { name: "Prepare decision" });
    expect(
      screen.getByRole("radio", { name: /Record it as it happened/ }),
    ).toBeChecked();
    expect(prepare).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: "  Customer paid cash  " },
    });
    fireEvent.click(prepare);
    expect(onPrepare).toHaveBeenCalledWith(
      { decision: "recorded", reason: "Customer paid cash" },
      expect.any(String),
    );
  });

  it("prepares with one idempotency key per decision and reason, so a retry can't prepare twice", () => {
    const { onPrepare } = renderDetail(detail());
    const reason = screen.getByRole("textbox", { name: "Reason" });
    const prepare = screen.getByRole("button", { name: "Prepare decision" });
    fireEvent.change(reason, { target: { value: "Paid cash" } });
    fireEvent.click(prepare);
    fireEvent.click(prepare);
    fireEvent.change(reason, { target: { value: "Paid cash, receipt kept" } });
    fireEvent.click(prepare);
    const keys = onPrepare.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("won't not honour a shift record the till can take, and says why", () => {
    renderDetail(
      detail({
        kind: "shift_open",
        entry: {
          ...detail().entry,
          kind: "shift_open",
          openingCashMinor: 5000,
        } as RefusedRecordDetail["entry"],
        notHonoured: {
          ok: false,
          message:
            "The till can take this shift record, so it is recorded. Not honouring it would leave every later record in that shift unrecordable.",
        },
      }),
    );
    expect(
      screen.getByRole("radio", { name: /Don't honour it/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: /Record it as it happened/ }),
    ).toBeChecked();
    expect(
      screen.getByText(/Not possible: The till can take this shift record/),
    ).toBeInTheDocument();
  });

  it("says what not honouring a card sale leaves behind", () => {
    renderDetail(
      detail({
        recordable: {
          ok: false,
          blocker: "shift_not_theirs",
          message: "The shift it names is someone else's.",
        },
        notHonoured: {
          ok: true,
          message:
            "No sale, payment or stock is recorded. The card payment was taken, so it is kept as collected, not sold, for a refund or a re-sale at the counter.",
        },
      }),
    );
    expect(screen.getByText(/kept as collected, not sold/)).toBeInTheDocument();
    expect(
      screen.getByText(/Not possible: The shift it names is someone else's/),
    ).toBeInTheDocument();
  });

  it("shows the card money a not-honoured sale took as collected, not sold", () => {
    renderDetail(
      detail({
        state: "settled",
        settleBlocker: {
          code: "settled",
          message: "This record is already settled.",
        },
        settlements: [
          settlement({
            decision: "not_honoured",
            status: "settled",
            approver: owner,
            settledAt: "2026-11-10T05:20:00.000Z",
            approvalReview: null,
            collectedPayments: [
              {
                id: "cp-1",
                method: "external_card",
                amountMinor: 3658,
                providerReference: "TID-42",
                approvalCode: "A1B2",
                approvedAt: "2026-11-10T04:00:00.000Z",
                shiftId: "shift-1",
                collectedAt: "2026-11-10T04:00:00.000Z",
              },
            ],
          }),
        ],
      }),
    );
    const decision = screen.getByRole("region", { name: "Decision" });
    expect(decision).toHaveTextContent(
      /Card money collected, not sold: LKR 36.58/,
    );
    expect(
      within(decision).getByRole("list", { name: "Collected, not sold" }),
    ).toHaveTextContent("ref TID-42 · approval A1B2");
  });

  it("offers only not honouring when the record can't be recorded, and says why", () => {
    const { onPrepare } = renderDetail(
      detail({
        recordable: {
          ok: false,
          blocker: "prices_differ",
          message: "Its prices or tax are not the saved stock's.",
        },
      }),
    );
    expect(
      screen.getByRole("radio", { name: /Record it as it happened/ }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        /Not possible: Its prices or tax are not the saved stock's/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Don't honour it/ }),
    ).toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Keyed wrongly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare decision" }));
    expect(onPrepare).toHaveBeenCalledWith(
      { decision: "not_honoured", reason: "Keyed wrongly" },
      expect.any(String),
    );
  });

  it("approves the exact decision shown, with one approval ID per content, unless it is the requester's own", () => {
    const { onApprove } = renderDetail(detail({ settlements: [settlement()] }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and settle" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and settle" }));
    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(onApprove.mock.calls[0]![1]).toBe(onApprove.mock.calls[1]![1]);
    expect(onApprove.mock.calls[0]![0]).toMatchObject({ id: "settlement-1" });
    expect(
      screen.queryByRole("button", { name: "Prepare decision" }),
    ).toBeNull();
  });

  it("hides approval from a requester whose role can't approve its own", () => {
    renderDetail(detail({ settlements: [settlement()] }), {
      userId: "u-manager",
      canSelfApprove: false,
    });
    expect(
      screen.queryByRole("button", { name: "Approve and settle" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Cancel decision" }),
    ).toBeInTheDocument();
  });

  it("shows a settled sale with its stock case, and says the counter carries on", () => {
    renderDetail(
      detail({
        state: "settled",
        settleBlocker: {
          code: "settled",
          message: "This record is already settled.",
        },
        settlements: [
          settlement({
            status: "settled",
            approver: owner,
            approvedAt: "2026-11-10T05:20:00.000Z",
            settledAt: "2026-11-10T05:20:00.000Z",
            executionApprovalId: "ap-1",
            approvalReview: null,
            sale: {
              id: "sale-1",
              invoiceNo: "INV-2611-000050",
              stockCaseId: "case-9",
            },
          }),
        ],
      }),
    );
    const decision = screen.getByRole("region", { name: "Decision" });
    expect(decision).toHaveTextContent(/Owner Perera/);
    expect(
      within(decision).getByRole("link", { name: /stock case/ }),
    ).toHaveAttribute("href", "/inventory/stock-cases?caseId=case-9");
    expect(decision).toHaveTextContent(/INV-2611-000050/);
    expect(decision).toHaveTextContent(/carries on/);
  });

  it("explains why nothing can be decided on a revoked counter's record", () => {
    renderDetail(
      detail({
        settleBlocker: {
          code: "counter_revoked",
          message: "This counter was revoked or retired.",
        },
        recordable: null,
      }),
    );
    expect(
      screen.getByText("This counter was revoked or retired."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare decision" }),
    ).toBeNull();
  });

  it("lists the branch's waiting records and opens the first", async () => {
    jest.mocked(useAuth).mockReturnValue({
      branchId: "branch-a",
      user: { id: "u-owner" },
    } as never);
    jest.mocked(usePermissions).mockReturnValue({
      permissionKeys: ["sales.review_offline_entries"],
      canSelfApprove: true,
    } as never);
    const summary: RefusedRecordSummary = {
      id: "review-1",
      state: "open",
      kind: "ordinary_sale",
      sequence: 7,
      counter: "Front",
      occurredAt: "2026-11-10T04:00:00.000Z",
      staff: "Dilini Cashier",
      totalMinor: 3658,
      refusal: {
        code: "GRANT_EXPIRED",
        explanation: "Sold after the permission ran out.",
      },
      attempts: 3,
      firstReceivedAt: "2026-11-10T05:00:00.000Z",
      settlement: null,
      collectedNotSoldMinor: null,
    };
    jest
      .mocked(apiJson)
      .mockImplementation(
        async (path: string) =>
          (path.startsWith("/offline-journal-reviews?")
            ? [summary]
            : detail()) as never,
      );
    render(<OfflineRecordsRoute />);
    expect(
      await screen.findByRole("button", { name: /Offline sale · LKR 36.58/ }),
    ).toHaveTextContent("Needs a decision");
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith("/offline-journal-reviews/review-1"),
    );
    expect(apiJson).toHaveBeenCalledWith(
      "/offline-journal-reviews?status=open",
    );
  });
});
