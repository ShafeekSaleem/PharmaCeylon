import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  OfflineCounterRestoresView,
  OfflineCounterRestoreView,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { CounterRestoreCard, lostSince } from "./counter-restore-card";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    branchId: "branch-a",
    user: { id: "owner", branchRoles: [] },
  }),
}));

const api = apiJson as jest.Mock;
const HOUR = 3_600_000;
const NOW = Date.now();
const restore = (
  over: Partial<OfflineCounterRestoreView> = {},
): OfflineCounterRestoreView => ({
  id: "restore-a",
  restoreId: "restore-id-a",
  status: "awaiting_acknowledgement",
  terminalId: "terminal-a",
  terminalLabel: "Front counter",
  enrollmentId: "enrollment-a",
  reportedAt: NOW - HOUR,
  backupTakenAt: NOW - 5 * HOUR,
  restoredAt: NOW - 2 * HOUR,
  journalHead: { sequence: 4, hash: "a".repeat(64) },
  serverHead: { sequence: 9, hash: "b".repeat(64) },
  outageActive: true,
  removedGrantVersion: 3,
  latestGrantVersion: 5,
  lastContactAt: NOW - 3 * HOUR,
  acknowledgement: null,
  ...over,
});
const list = (
  restores: OfflineCounterRestoreView[],
): OfflineCounterRestoresView => ({
  branchId: "branch-a",
  restores,
});

beforeEach(() => api.mockReset());

describe("CounterRestoreCard (P5 #51)", () => {
  it("says what a restored counter may have lost since its backup or last contact", async () => {
    const r = restore();
    api.mockResolvedValueOnce(list([r]));
    render(<CounterRestoreCard />);
    const rows = await screen.findByLabelText("Restores waiting for you");
    expect(within(rows).getByText(/during an internet outage/)).toBeTruthy();
    expect(
      within(rows).getByText(
        /server has 9 offline records from it; the backup had 4/,
      ),
    ).toBeTruthy();
    expect(lostSince(r)).toBe(r.lastContactAt);
    expect(lostSince(restore({ lastContactAt: null }))).toBe(r.backupTakenAt);
    expect(api).toHaveBeenCalledWith("/offline-counter-restores", {
      headers: { "x-branch-id": "branch-a" },
    });
  });

  it("acknowledges a restore with how receipts, cash and stock were checked", async () => {
    api.mockResolvedValueOnce(list([restore()]));
    render(<CounterRestoreCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Acknowledge Front counter" }),
    );
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Acknowledge restore",
    });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(
      within(dialog).getByLabelText(
        /How receipts, cash and stock were checked/,
      ),
      {
        target: {
          value: "Counted the drawer; two receipts re-entered online.",
        },
      },
    );
    const done = restore({
      status: "acknowledged",
      acknowledgement: {
        acknowledgedByUserId: "owner",
        acknowledgedByFullName: "Owner",
        acknowledgedAt: Date.now(),
        reason: "Counted the drawer; two receipts re-entered online.",
        authority: "owner",
      },
    });
    api.mockResolvedValueOnce(done).mockResolvedValueOnce(list([done]));
    fireEvent.click(confirm);
    await screen.findByText(/Restore acknowledged/);
    const [path, init] = api.mock.calls[1]!;
    expect(path).toBe("/offline-counter-restores/restore-a/acknowledge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      reason: "Counted the drawer; two receipts re-entered online.",
    });
    await screen.findByText(/No restored counter is waiting for you/);
    expect(
      screen.getByText(/acknowledged .* by Owner: Counted the drawer/),
    ).toBeTruthy();
  });

  it("shows the API's refusal and keeps the dialog open", async () => {
    api.mockResolvedValueOnce(list([restore()]));
    render(<CounterRestoreCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Acknowledge Front counter" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByLabelText(
        /How receipts, cash and stock were checked/,
      ),
      {
        target: { value: "Checked." },
      },
    );
    api.mockRejectedValueOnce(
      new Error(
        "Only an owner, or a manager the owner delegated, can acknowledge this.",
      ),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Acknowledge restore" }),
    );
    expect(await within(dialog).findByText(/Only an owner/)).toBeTruthy();
  });
});
