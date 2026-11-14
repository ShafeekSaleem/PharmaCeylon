import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CounterJournalSyncStatus,
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
  hasHistory: false,
  hasOpenShift: false,
  terminal: null,
};
const enrolled: TerminalCounterView = {
  registerId: "22222222-2222-4222-8222-222222222222",
  tillId: "t2",
  label: "Back counter",
  isActive: true,
  hasHistory: true,
  hasOpenShift: false,
  terminal: {
    terminalId: "33333333-3333-4333-8333-333333333333",
    label: "DISPENSARY-PC",
    enrollmentId: "44444444-4444-4444-8444-444444444444",
    enrolledAt: Date.UTC(2026, 9, 30),
  },
};
const retired: TerminalCounterView = {
  registerId: "77777777-7777-4777-8777-777777777777",
  tillId: "t3",
  label: "Old till",
  isActive: false,
  hasHistory: true,
  hasOpenShift: false,
  terminal: null,
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
  lastReceivedAt: noon.getTime(),
  stoppedAt: null,
  openStockCases: 0,
};
const ZONE = "Asia/Colombo";
const status = (...enrollments: CounterJournalSyncView[]): CounterJournalSyncStatus => ({
  timezone: ZONE,
  enrollments,
});
let journal: CounterJournalSyncStatus | Error = status(synced);

beforeEach(() => {
  journal = status(synced);
  (apiJson as jest.Mock).mockReset();
  (apiJson as jest.Mock).mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST" && path === "/terminals/enrollment-codes")
      return Promise.resolve({ code: "ABCDE-FGHJK", view: code });
    if (init?.method === "PATCH") return Promise.resolve(empty);
    if (init?.method === "DELETE" || init?.method === "POST") return Promise.resolve(undefined);
    if (path === "/terminals/counters?includeInactive=true")
      return Promise.resolve([empty, enrolled, retired]);
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

describe("renaming, stopping use of and deleting counters (#180)", () => {
  const rowOf = async (name: string) =>
    (await screen.findByText(name, { selector: "td" })).closest("tr")!;
  const sent = (method: string) =>
    (apiJson as jest.Mock).mock.calls.find((c) => c[1]?.method === method);

  it("renames a counter", async () => {
    render(<CountersSettingsPage />);
    fireEvent.click(within(await rowOf("Front counter")).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Counter name"), { target: { value: "Front till" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith(
        `/terminals/counters/${empty.registerId}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ label: "Front till" }) }),
      ),
    );
  });

  it("shows the server's plain reason when a rename is refused", async () => {
    render(<CountersSettingsPage />);
    (apiJson as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error("Another counter already has that name.")));
    fireEvent.click(within(await rowOf("Front counter")).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Counter name"), { target: { value: "Back counter" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Another counter already has that name.")).toBeInTheDocument();
  });

  it("stops using an idle counter after confirming", async () => {
    render(<CountersSettingsPage />);
    fireEvent.click(within(await rowOf("Front counter")).getByRole("button", { name: "Stop using" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop using" }));
    await waitFor(() =>
      expect(sent("PATCH")![1].body).toBe(JSON.stringify({ isActive: false })),
    );
  });

  it("will not stop a counter that still has a computer, and says why", async () => {
    render(<CountersSettingsPage />);
    const back = await rowOf("Back counter");
    expect(within(back).getByRole("button", { name: "Stop using" })).toBeDisabled();
    expect(within(back).getByText(/A computer is still set up here/)).toBeInTheDocument();
  });

  it("only offers Delete on a counter that was never used", async () => {
    render(<CountersSettingsPage />);
    const back = await rowOf("Back counter");
    expect(within(back).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(back).getByText(/records are kept/)).toBeInTheDocument();
    const front = await rowOf("Front counter");
    fireEvent.click(within(front).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete counter" }));
    await waitFor(() => expect(sent("DELETE")![0]).toBe(`/terminals/counters/${empty.registerId}`));
  });

  it("lists counters no longer in use on request, and starts using one again", async () => {
    render(<CountersSettingsPage />);
    await rowOf("Front counter");
    expect(screen.queryByText("Old till")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show counters no longer in use"));
    const old = await rowOf("Old till");
    expect(within(old).getByText("Inactive")).toBeInTheDocument();
    fireEvent.click(within(old).getByRole("button", { name: "Use again" }));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith(
        `/terminals/counters/${retired.registerId}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ isActive: true }) }),
      ),
    );
  });
});

describe("offline sales (P5 #51)", () => {
  it("says a counter's offline sales are all on the server, with when the last of them arrived", async () => {
    render(<CountersSettingsPage />);
    const back = (await screen.findByText("Back counter")).closest("tr")!;
    expect(
      await within(back).findByText(
        `All on the server, last received ${syncTime(noon.getTime(), ZONE)}`,
      ),
    ).toBeInTheDocument();
    expect(apiJson).toHaveBeenCalledWith("/terminals/offline-journal/sync-status");
    // A counter with no computer has nothing to report.
    const front = screen.getByText("Front counter", { selector: "td" }).closest("tr")!;
    expect(within(front).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows where the journal stopped and links its open stock cases", async () => {
    journal = status({
      ...synced,
      stoppedAt: { sequence: 42, outcome: "rejected", errorCode: "GRANT_INVALID", since: noon.getTime() },
      openStockCases: 2,
    });
    render(<CountersSettingsPage />);
    const back = (await screen.findByText("Back counter")).closest("tr")!;
    expect(await within(back).findByText("Stopped at entry 42")).toBeInTheDocument();
    expect(
      within(back).getByText(
        `Refused ${syncTime(noon.getTime(), ZONE)}. Nothing after it syncs until it is reviewed.`,
      ),
    ).toBeInTheDocument();
    expect(within(back).getByRole("link", { name: "2 stock cases open" })).toHaveAttribute(
      "href",
      "/inventory/stock-cases",
    );
    expect(within(back).queryByText(/All on the server/)).not.toBeInTheDocument();
  });

  it("keeps an earlier, revoked key listed under its counter while its journal stops short", async () => {
    journal = status(synced, {
      ...synced,
      enrollmentId: "66666666-6666-4666-8666-666666666666",
      terminalLabel: "OLD-PC",
      current: false,
      revokedAt: noon.getTime(),
      stoppedAt: { sequence: 9, outcome: "held", errorCode: "TERMINAL_REVOKED", since: noon.getTime() },
      openStockCases: 1,
    });
    render(<CountersSettingsPage />);
    const back = (await screen.findByText("Back counter")).closest("tr")!;
    const earlier = await within(back).findByText(/OLD-PC, key revoked/);
    expect(earlier).toHaveTextContent("stopped at entry 9");
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
