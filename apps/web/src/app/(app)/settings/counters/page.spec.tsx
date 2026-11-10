import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CounterJournalSyncView,
  TerminalCounterView,
  TerminalEnrollmentCodeView,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { syncTime } from "./offline-sync";
import CountersSettingsPage from "./page";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({ useAuth: () => ({ branchId: "branch-1" }) }));

const empty: TerminalCounterView = {
  registerId: "11111111-1111-4111-8111-111111111111",
  tillId: "t1",
  label: "Front counter",
  isActive: true,
  terminal: null,
};
const enrolled: TerminalCounterView = {
  registerId: "22222222-2222-4222-8222-222222222222",
  tillId: "t2",
  label: "Back counter",
  isActive: true,
  terminal: {
    terminalId: "33333333-3333-4333-8333-333333333333",
    label: "DISPENSARY-PC",
    enrollmentId: "44444444-4444-4444-8444-444444444444",
    enrolledAt: Date.UTC(2026, 9, 30),
  },
};
const code: TerminalEnrollmentCodeView = {
  codeId: "55555555-5555-4555-8555-555555555555",
  registerId: empty.registerId,
  tillId: "t1",
  counterLabel: "Front counter",
  createdByUserId: "u1",
  createdAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  usedAt: null,
  usedByUserId: null,
  enrollmentId: null,
  revokedAt: null,
  status: "outstanding",
};

const noon = new Date();
noon.setHours(12, 2, 0, 0);
const synced: CounterJournalSyncView = {
  enrollmentId: enrolled.terminal!.enrollmentId!,
  terminalId: enrolled.terminal!.terminalId,
  terminalLabel: "DISPENSARY-PC",
  registerId: enrolled.registerId,
  current: true,
  revokedAt: null,
  retiredAt: null,
  head: { sequence: 41, acceptedAt: noon.getTime() - 60_000 },
  lastUploadAt: noon.getTime(),
  waiting: 0,
  needsReview: 0,
  stuck: null,
  openStockCases: 0,
};
let journal: CounterJournalSyncView[] | Error = [synced];

beforeEach(() => {
  journal = [synced];
  (apiJson as jest.Mock).mockReset();
  (apiJson as jest.Mock).mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST" && path === "/terminals/enrollment-codes")
      return Promise.resolve({ code: "ABCDE-FGHJK", view: code });
    if (init?.method === "POST") return Promise.resolve(undefined);
    if (path === "/terminals/counters") return Promise.resolve([empty, enrolled]);
    if (path === "/terminals/enrollment-codes") return Promise.resolve([code]);
    if (path === "/terminals/offline-journal/sync-status")
      return journal instanceof Error ? Promise.reject(journal) : Promise.resolve(journal);
    return Promise.reject(new Error(path));
  });
});

it("shows each counter with its computer and status", async () => {
  render(<CountersSettingsPage />);
  const back = (await screen.findByText("Back counter")).closest("tr")!;
  expect(within(back).getByText("DISPENSARY-PC")).toBeInTheDocument();
  expect(within(back).getByText("Enrolled")).toBeInTheDocument();
  const front = screen.getByText("Front counter", { selector: "td" }).closest("tr")!;
  expect(within(front).getByText("No computer")).toBeInTheDocument();
  expect(within(front).getByText(/Code waiting/)).toBeInTheDocument();
});

it("issues an enrollment code and shows it once", async () => {
  render(<CountersSettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Enrollment code" }));
  fireEvent.click(screen.getByRole("button", { name: "Issue code" }));
  expect(await screen.findByLabelText("Enrollment code")).toHaveTextContent("ABCDE-FGHJK");
  const issue = (apiJson as jest.Mock).mock.calls.find(
    (c) => c[0] === "/terminals/enrollment-codes" && c[1]?.method === "POST",
  )!;
  expect(JSON.parse(issue[1].body)).toEqual({ registerId: empty.registerId, expiresInMinutes: 60 });
});

it("reports a computer lost only with a reason", async () => {
  render(<CountersSettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Report lost" }));
  const revoke = screen.getByRole("button", { name: "Revoke key" });
  expect(revoke).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Stolen overnight" } });
  fireEvent.click(revoke);
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(
      `/terminals/enrollments/${enrolled.terminal!.enrollmentId}/revoke`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "Stolen overnight" }) }),
    ),
  );
});

it("revokes a waiting code", async () => {
  render(<CountersSettingsPage />);
  const section = await screen.findByRole("region", { name: "Waiting enrollment codes" });
  fireEvent.click(within(section).getByRole("button", { name: "Revoke" }));
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(`/terminals/enrollment-codes/${code.codeId}/revoke`, {
      method: "POST",
    }),
  );
});

describe("offline sales (P5 #51)", () => {
  it("says a counter's offline sales are all on the server, with the last sync", async () => {
    render(<CountersSettingsPage />);
    const back = (await screen.findByText("Back counter")).closest("tr")!;
    expect(
      await within(back).findByText(`All on the server, last sync ${syncTime(noon.getTime())}`),
    ).toBeInTheDocument();
    expect(apiJson).toHaveBeenCalledWith("/terminals/offline-journal/sync-status");
    // A counter with no computer has nothing to report.
    const front = screen.getByText("Front counter", { selector: "td" }).closest("tr")!;
    expect(within(front).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows what waits, where the journal stopped, and links its open stock cases", async () => {
    journal = [
      {
        ...synced,
        waiting: 3,
        needsReview: 1,
        stuck: { sequence: 42, outcome: "rejected", errorCode: "GRANT_INVALID", since: noon.getTime() },
        openStockCases: 2,
      },
    ];
    render(<CountersSettingsPage />);
    const back = (await screen.findByText("Back counter")).closest("tr")!;
    expect(await within(back).findByText("3 waiting / 1 needs review")).toBeInTheDocument();
    expect(within(back).getByText(/Stopped at entry 42, which was refused/)).toBeInTheDocument();
    expect(within(back).getByRole("link", { name: "2 stock cases open" })).toHaveAttribute(
      "href",
      "/inventory/stock-cases",
    );
    expect(within(back).queryByText(/All on the server/)).not.toBeInTheDocument();
  });

  it("keeps an earlier, revoked key listed under its counter while its entries wait", async () => {
    journal = [
      synced,
      {
        ...synced,
        enrollmentId: "66666666-6666-4666-8666-666666666666",
        terminalLabel: "OLD-PC",
        current: false,
        revokedAt: noon.getTime(),
        waiting: 2,
        openStockCases: 1,
      },
    ];
    render(<CountersSettingsPage />);
    const back = (await screen.findByText("Back counter")).closest("tr")!;
    const earlier = await within(back).findByText(/OLD-PC, key revoked/);
    expect(earlier).toHaveTextContent("2 waiting");
    expect(within(earlier).getByRole("link", { name: "1 stock case open" })).toBeInTheDocument();
    expect(within(back).getByText(/All on the server/)).toBeInTheDocument();
  });

  it("still lists the counters when the sync status can't be read", async () => {
    journal = new Error("Forbidden");
    render(<CountersSettingsPage />);
    const back = (await screen.findByText("Back counter")).closest("tr")!;
    expect(await within(back).findByText("Couldn't check")).toBeInTheDocument();
    expect(within(back).getByText("Enrolled")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
