import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  OfflineCounterReplacementView,
  OfflineJournalRecoveriesView,
  OfflineJournalRecoveryView,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { JournalRecoveryCard } from "./journal-recovery-card";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    branchId: "branch-a",
    user: { id: "owner", branchRoles: [] },
  }),
}));

const api = apiJson as jest.Mock;
const HOUR = 3_600_000;
const head = {
  sequence: 12,
  hash: "a".repeat(64),
  acceptedAt: Date.now() - HOUR,
};
const counter = (
  over: Partial<OfflineCounterReplacementView> = {},
): OfflineCounterReplacementView => ({
  terminalId: "terminal-a",
  terminalLabel: "Front counter",
  enrollmentId: "enrollment-a",
  nominationVersion: 3,
  revoked: true,
  cutoff: {
    kind: "device_disabled",
    at: Date.now() - HOUR,
    lastGrantExpiresAt: Date.now() + 2 * HOUR,
  },
  serverHead: head,
  refusals: [],
  signOffAvailableAt: Date.now() + 2 * HOUR,
  signOff: null,
  journalCleared: false,
  ...over,
});
const list = (
  over: Partial<OfflineJournalRecoveriesView> = {},
): OfflineJournalRecoveriesView => ({
  branchId: "branch-a",
  recoveries: [],
  offlineCounter: counter(),
  ...over,
});
const restore: OfflineJournalRecoveryView = {
  recoveryId: "recovery-a",
  kind: "counter_restore",
  status: "awaiting_approval",
  terminalId: "terminal-b",
  terminalLabel: "Back counter",
  enrollmentId: "enrollment-b",
  createdAt: Date.now() - HOUR,
  serverHead: head,
  localHead: { sequence: 10, hash: "b".repeat(64) },
  commonPrefix: { sequence: 8, hash: "c".repeat(64) },
  restoredEntries: 4,
  unmatched: [
    {
      sequence: 9,
      commandId: "cmd-9",
      hash: "d".repeat(64),
      kind: "ordinary_sale",
      occurredAt: Date.now() - 2 * HOUR,
      staffUserId: "u1",
      staffFullName: "Nimal",
      totalMinor: 125_000,
      lineCount: 2,
    },
    {
      sequence: 10,
      commandId: "cmd-10",
      hash: "e".repeat(64),
      kind: "ordinary_sale",
      occurredAt: Date.now() - HOUR,
      staffUserId: "u1",
      staffFullName: "Nimal",
      totalMinor: 5_000,
      lineCount: 1,
    },
  ],
  refusals: [],
  nominationVersion: null,
  cutoff: null,
  approval: null,
  completedAt: null,
  supersededAt: null,
  stale: false,
};

beforeEach(() => api.mockReset());

describe("JournalRecoveryCard (D11)", () => {
  it("waits out the offline counter's last permission before its journal can be signed off", async () => {
    api.mockResolvedValueOnce(list());
    render(<JournalRecoveryCard />);
    const row = await screen.findByLabelText("Offline counter");
    expect(within(row).getByText(/server has 12 offline records/)).toBeTruthy();
    expect(
      within(row).getByText(/could still be selling offline/),
    ).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "Sign off journal" }),
    ).toHaveProperty("disabled", true);
    expect(api).toHaveBeenCalledWith("/offline-journal-recoveries", {
      headers: { "x-branch-id": "branch-a" },
    });
  });

  it("signs off exactly the journal it showed, with what was checked", async () => {
    api.mockResolvedValueOnce(
      list({ offlineCounter: counter({ signOffAvailableAt: Date.now() - 1 }) }),
    );
    render(<JournalRecoveryCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign off journal" }),
    );
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Sign off journal",
    });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText(/What you checked/), {
      target: { value: "Disk failed; counted the shelf." },
    });
    api
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(
        list({
          offlineCounter: counter({
            journalCleared: true,
            signOff: {
              recoveryId: "s",
              approvedAt: Date.now(),
              approvedByFullName: "Owner",
              current: true,
            },
          }),
        }),
      );
    fireEvent.click(confirm);
    await screen.findByText(/Another counter can now take over/);
    const [path, init] = api.mock.calls[1]!;
    expect(path).toBe("/offline-journal-recoveries/missing-journal");
    expect(JSON.parse(init.body)).toEqual({
      enrollmentId: "enrollment-a",
      expectedNominationVersion: 3,
      expectedServerHeadSequence: 12,
      reason: "Disk failed; counted the shelf.",
    });
    await screen.findByText(/Journal signed off by Owner/);
  });

  it("shows why an earlier sign-off no longer counts", async () => {
    api.mockResolvedValueOnce(
      list({
        offlineCounter: counter({
          signOffAvailableAt: null,
          signOff: {
            recoveryId: "s",
            approvedAt: 1,
            approvedByFullName: "Owner",
            current: false,
          },
        }),
      }),
    );
    render(<JournalRecoveryCard />);
    expect(
      await screen.findByText(/no longer covers this journal/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign off journal" }),
    ).toHaveProperty("disabled", false);
  });

  it("reviews a restored counter's unmatched records as evidence and approves exactly them", async () => {
    api.mockResolvedValueOnce(
      list({
        offlineCounter: null,
        recoveries: [
          {
            recoveryId: "recovery-a",
            kind: "counter_restore",
            status: "awaiting_approval",
            terminalId: "terminal-b",
            terminalLabel: "Back counter",
            enrollmentId: "enrollment-b",
            createdAt: Date.now() - HOUR,
            stale: false,
            unmatched: 2,
          },
        ],
      }),
    );
    render(<JournalRecoveryCard />);
    expect(
      await screen.findByText(/2 offline records the server never received/),
    ).toBeTruthy();
    api.mockResolvedValueOnce(restore);
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    const table = await screen.findByRole("table", {
      name: "Records the server never received",
    });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("LKR 1,250.00")).toBeTruthy();
    expect(screen.getByText(/not/, { selector: "strong" })).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText(/How the stock and cash were settled/),
      {
        target: { value: "Adjusted 3 units out; cash counted." },
      },
    );
    api
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(list({ offlineCounter: null }));
    fireEvent.click(screen.getByRole("button", { name: "Approve recovery" }));
    await screen.findByText(/Recovery approved/);
    const [path, init] = api.mock.calls[2]!;
    expect(path).toBe("/offline-journal-recoveries/recovery-a/approve");
    expect(JSON.parse(init.body)).toEqual({
      reason: "Adjusted 3 units out; cash counted.",
      expectedServerHeadSequence: 12,
      expectedUnmatched: 2,
    });
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    api.mockResolvedValueOnce(
      list({ offlineCounter: counter({ signOffAvailableAt: null }) }),
    );
    render(<JournalRecoveryCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign off journal" }),
    );
    fireEvent.change(screen.getByLabelText(/What you checked/), {
      target: { value: "Checked" },
    });
    api.mockRejectedValueOnce(
      new Error(
        "Only an owner, or a manager the owner delegated, can approve this.",
      ),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Sign off journal",
      }),
    );
    await waitFor(() => expect(screen.getByText(/Only an owner/)).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
