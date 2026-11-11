import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  OfflineCounterRestoresView,
  OfflineCounterRestoreView,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { CounterRestoreCard, span } from "./counter-restore-card";

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
  clockSkew: null,
  acknowledgement: null,
  ...over,
});
const when = (at: number) => new Date(at).toLocaleString();
const list = (
  restores: OfflineCounterRestoreView[],
): OfflineCounterRestoresView => ({
  branchId: "branch-a",
  restores,
});

beforeEach(() => api.mockReset());

describe("CounterRestoreCard (P5 #51)", () => {
  it("says what a restored counter may have lost since its backup, whatever contact came after", async () => {
    // Backup 5 h ago, then an outage whose sales were never accepted, then a sign-in 3 h ago
    // while the drain was unfinished. The check starts at the backup, not at that sign-in.
    const r = restore();
    api.mockResolvedValueOnce(list([r]));
    render(<CounterRestoreCard />);
    const rows = await screen.findByLabelText("Restores waiting for you");
    const hint = within(rows).getByText(/during an internet outage/);
    expect(hint.textContent).toContain(
      `check receipts, cash and stock from ${when(r.backupTakenAt)}.`,
    );
    expect(hint.textContent).toContain(
      `The server last heard from it ${when(r.lastContactAt!)}; that doesn't mean every sale before then reached the server.`,
    );
    expect(hint.textContent).not.toContain("clock");
    expect(
      within(rows).getByText(
        /server has 9 offline records from it; the backup had 4/,
      ),
    ).toBeTruthy();
    expect(api).toHaveBeenCalledWith("/offline-counter-restores", {
      headers: { "x-branch-id": "branch-a" },
    });
  });

  it("warns when the counter's clock was wrong, instead of counting from its times", async () => {
    // A reset clock: the restore is dated years before the backup.
    const r = restore({
      restoredAt: Date.UTC(2000, 0, 1),
      lastContactAt: null,
      clockSkew: {
        backupAfterRestoreMs: 27 * 365 * 24 * HOUR,
        aheadOfServerMs: 0,
      },
    });
    api.mockResolvedValueOnce(list([r]));
    render(<CounterRestoreCard />);
    const rows = await screen.findByLabelText("Restores waiting for you");
    const hint = within(rows).getByText(/clock was wrong/);
    expect(hint.textContent).toContain(
      "This counter's clock was wrong (its backup is dated 27 years after its restore), so the times it gave can't be trusted. Check receipts, cash and stock from the last sale you know reached the server.",
    );
    expect(hint.textContent).not.toContain(
      "check receipts, cash and stock from ",
    );
    expect(hint.textContent).not.toContain("last heard");
    expect(span(2 * HOUR)).toBe("2 hours");
    expect(span(30_000)).toBe("1 minute");
    expect(span(3 * 24 * HOUR)).toBe("3 days");
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
