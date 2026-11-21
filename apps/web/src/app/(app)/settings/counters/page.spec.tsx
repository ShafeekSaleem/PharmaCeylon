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

const mockSetBranchId = jest.fn();
jest.mock("@/lib/auth-client", () => ({
  apiJson: jest.fn(),
  fetchTenantBranches: jest.fn(() =>
    Promise.resolve([
      { id: "branch-1", code: "CMB", name: "Colombo — Main", city: null, timezone: "Asia/Colombo" },
      { id: "branch-2", code: "GAL", name: "Galle — Fort", city: null, timezone: "Asia/Colombo" },
      { id: "branch-3", code: "KDY", name: "Kandy", city: null, timezone: "Asia/Colombo" },
    ]),
  ),
}));
const managerRoles = [
  { branchId: "branch-1", role: "manager", roleId: "r1" },
  { branchId: "branch-2", role: "manager", roleId: "r1" },
];
let mockRoles = managerRoles;
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({
    branchId: "branch-1",
    user: { branchRoles: mockRoles },
    setBranchId: mockSetBranchId,
  }),
}));
// The tenant-wide counter defaults card has its own tests; this file covers the counters.
jest.mock("./counter-defaults-card", () => ({ CounterDefaultsCard: () => null }));

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

afterEach(() => {
  mockRoles = managerRoles;
  mockSetBranchId.mockReset();
});

const cardOf = async (name: string) => screen.findByRole("region", { name });
const openMenu = (card: HTMLElement, name: string) =>
  fireEvent.click(within(card).getByRole("button", { name: `Actions for ${name}` }));
const sent = (method: string) =>
  (apiJson as jest.Mock).mock.calls.find((c) => c[1]?.method === method);

describe("one card per counter (UI1 #205)", () => {
  it("shows each counter's state in plain words, with its computer and enrol date", async () => {
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    expect(within(back).getByText("In use")).toBeInTheDocument();
    expect(within(back).getByText(/DISPENSARY-PC · enrolled/)).toBeInTheDocument();
    const front = await cardOf("Front counter");
    expect(within(front).getByText("No computer yet")).toBeInTheDocument();
    expect(within(front).getAllByText(/Code waiting, expires/).length).toBeGreaterThan(0);
  });

  it("gives a counter with no computer one primary action and the enrolment steps", async () => {
    render(<CountersSettingsPage />);
    const front = await cardOf("Front counter");
    expect(within(front).getByRole("button", { name: "Get enrolment code" })).toBeInTheDocument();
    expect(within(front).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    const steps = within(front).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[1]).toHaveTextContent(/Open PharmaCeylon POS on the new computer/);
    // No computer, so nothing to report lost or retire.
    expect(within(front).queryByRole("button", { name: "Retire this computer" })).toBeNull();
  });

  it("makes Rename the primary action once a computer is enrolled, and keeps the rest in a menu", async () => {
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    expect(within(back).getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(within(back).queryByRole("button", { name: "Stop using" })).toBeNull();
    expect(within(back).queryByRole("button", { name: "Delete" })).toBeNull();
    openMenu(back, "Back counter");
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual([expect.stringMatching(/^Stop using/), expect.stringMatching(/^Delete/)]);
  });

  it("explains a blocked action once, inside the menu, not as fine print on the card", async () => {
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    expect(within(back).queryByText(/A computer is still set up here/)).toBeNull();
    openMenu(back, "Back counter");
    const stop = screen.getByRole("menuitem", { name: /^Stop using/ });
    expect(stop).toBeDisabled();
    expect(stop).toHaveTextContent("A computer is still set up here. Retire it first.");
    const del = screen.getByRole("menuitem", { name: /^Delete/ });
    expect(del).toBeDisabled();
    expect(del).toHaveTextContent(/records are kept/);
  });

  it("shows when the computer last sent offline sales, what reached the server, and the shift", async () => {
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    expect(await within(back).findByText("All on the server")).toBeInTheDocument();
    expect(within(back).getByText(syncTime(noon.getTime(), ZONE))).toBeInTheDocument();
    expect(within(back).getByText("Last offline upload")).toBeInTheDocument();
    expect(within(back).getByText("None")).toBeInTheDocument();
  });

  it("says so when a shift is open, as far as the API reports it", async () => {
    (apiJson as jest.Mock).mockImplementation((path: string) => {
      if (path === "/terminals/counters")
        return Promise.resolve([{ ...enrolled, hasOpenShift: true }]);
      if (path === "/terminals/enrollment-codes") return Promise.resolve([]);
      if (path === "/terminals/offline-journal/sync-status") return Promise.resolve(status(synced));
      return Promise.reject(new Error(path));
    });
    render(<CountersSettingsPage />);
    expect(
      await within(await cardOf("Back counter")).findByText("A shift is open"),
    ).toBeInTheDocument();
  });

  it("warns when two counters in use have names staff could mix up", async () => {
    (apiJson as jest.Mock).mockImplementation((path: string) => {
      if (path === "/terminals/counters")
        return Promise.resolve([
          { ...empty, label: "Counter 1" },
          { ...enrolled, label: "counter 1 (2)" },
          { ...retired, label: "Counter 2", isActive: true },
        ]);
      if (path === "/terminals/enrollment-codes") return Promise.resolve([]);
      if (path === "/terminals/offline-journal/sync-status") return Promise.resolve(status(synced));
      return Promise.reject(new Error(path));
    });
    render(<CountersSettingsPage />);
    const copy = await cardOf("counter 1 (2)");
    expect(within(copy).getByRole("note")).toHaveTextContent(
      "The name is close to “Counter 1”. Rename it so staff can tell them apart.",
    );
    // "Counter 2" is a different counter, not a near-duplicate.
    expect(within(await cardOf("Counter 2")).queryByRole("note")).toBeNull();
  });
});

describe("choosing the branch on the page", () => {
  it("lists only the branches the person works at and switches to the one chosen", async () => {
    render(<CountersSettingsPage />);
    fireEvent.click(await screen.findByText("Branch"));
    expect(screen.queryByRole("option", { name: "Kandy" })).toBeNull();
    fireEvent.mouseDown(screen.getByRole("option", { name: "Galle — Fort" }));
    expect(mockSetBranchId).toHaveBeenCalledWith("branch-2");
  });

  it("is not shown to someone who works at one branch only", async () => {
    mockRoles = [{ branchId: "branch-1", role: "manager", roleId: "r1" }];
    render(<CountersSettingsPage />);
    await cardOf("Front counter");
    await waitFor(() => expect(screen.queryByText("Branch")).toBeNull());
  });
});

it("issues an enrolment code and shows it once", async () => {
  render(<CountersSettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Get enrolment code" }));
  fireEvent.click(screen.getByRole("button", { name: "Issue code" }));
  expect(await screen.findByLabelText("Enrollment code")).toHaveTextContent("ABCDE-FGHJK");
  const issue = (apiJson as jest.Mock).mock.calls.find(
    (c) => c[0] === "/terminals/enrollment-codes" && c[1]?.method === "POST",
  )!;
  expect(JSON.parse(issue[1].body)).toEqual({ registerId: empty.registerId, expiresInMinutes: 60 });
});

it("reports a computer lost only with a reason", async () => {
  render(<CountersSettingsPage />);
  const back = await cardOf("Back counter");
  fireEvent.click(within(back).getByRole("button", { name: "Report lost" }));
  const revoke = screen.getByRole("button", { name: "Revoke key" });
  expect(revoke).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Stolen overnight" } });
  fireEvent.click(revoke);
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(
      `/terminals/enrollments/${enrolled.terminal!.enrollmentId}/revoke`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "Stolen overnight" }),
      }),
    ),
  );
});

it("retires a computer only after a destructive, reasoned confirmation", async () => {
  render(<CountersSettingsPage />);
  const back = await cardOf("Back counter");
  fireEvent.click(within(back).getByRole("button", { name: "Retire this computer" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("Retire DISPENSARY-PC?");
  const confirm = within(dialog).getByRole("button", { name: "Retire computer" });
  expect(confirm).toBeDisabled();
  expect(sent("POST")).toBeUndefined();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Replaced" } });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(
      `/terminals/devices/${enrolled.terminal!.terminalId}/retire`,
      expect.objectContaining({ method: "POST" }),
    ),
  );
});

it("revokes a waiting code from the counter's card", async () => {
  render(<CountersSettingsPage />);
  const front = await cardOf("Front counter");
  fireEvent.click(
    within(front).getByRole("button", { name: "Revoke the waiting code for Front counter" }),
  );
  await waitFor(() =>
    expect(apiJson).toHaveBeenCalledWith(`/terminals/enrollment-codes/${code.codeId}/revoke`, {
      method: "POST",
    }),
  );
});

describe("renaming, stopping use of and deleting counters (#180)", () => {
  it("renames a counter", async () => {
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    fireEvent.click(within(back).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Counter name"), { target: { value: "Back till" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith(
        `/terminals/counters/${enrolled.registerId}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ label: "Back till" }) }),
      ),
    );
  });

  it("warns while renaming to a name close to another counter's", async () => {
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    fireEvent.click(within(back).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Counter name"), { target: { value: "front-counter" } });
    expect(within(screen.getByRole("dialog")).getByRole("note")).toHaveTextContent(
      "The name is close to “Front counter”",
    );
  });

  it("shows the server's plain reason when a rename is refused", async () => {
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    (apiJson as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("Another counter already has that name.")),
    );
    fireEvent.click(within(back).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Counter name"), { target: { value: "Front counter" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Another counter already has that name.")).toBeInTheDocument();
  });

  it("stops using an idle counter after confirming", async () => {
    render(<CountersSettingsPage />);
    openMenu(await cardOf("Front counter"), "Front counter");
    fireEvent.click(screen.getByRole("menuitem", { name: /^Stop using/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop using" }));
    await waitFor(() => expect(sent("PATCH")![1].body).toBe(JSON.stringify({ isActive: false })));
  });

  it("deletes a counter that was never used, after confirming", async () => {
    render(<CountersSettingsPage />);
    openMenu(await cardOf("Front counter"), "Front counter");
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete/ }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete counter" }),
    );
    await waitFor(() => expect(sent("DELETE")![0]).toBe(`/terminals/counters/${empty.registerId}`));
  });

  it("lists counters no longer in use on request, as Retired, and starts using one again", async () => {
    render(<CountersSettingsPage />);
    await cardOf("Front counter");
    expect(screen.queryByText("Old till")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show counters no longer in use"));
    const old = await cardOf("Old till");
    expect(within(old).getByText("Retired")).toBeInTheDocument();
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
  it("shows where the journal stopped and links its open stock cases", async () => {
    journal = status({
      ...synced,
      stoppedAt: {
        sequence: 42,
        outcome: "rejected",
        errorCode: "GRANT_INVALID",
        since: noon.getTime(),
      },
      openStockCases: 2,
    });
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
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
      stoppedAt: {
        sequence: 9,
        outcome: "held",
        errorCode: "TERMINAL_REVOKED",
        since: noon.getTime(),
      },
      openStockCases: 1,
    });
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    const earlier = await within(back).findByText(/OLD-PC, key revoked/);
    expect(earlier).toHaveTextContent("stopped at entry 9");
    expect(within(earlier).getByRole("link", { name: "1 stock case open" })).toBeInTheDocument();
    expect(within(back).getByText("All on the server")).toBeInTheDocument();
  });

  it("still lists the counters when the sync status can't be read", async () => {
    journal = new Error("Forbidden");
    render(<CountersSettingsPage />);
    const back = await cardOf("Back counter");
    expect((await within(back).findAllByText("Couldn't check")).length).toBe(2);
    expect(within(back).getByText("In use")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("adding a counter", () => {
  it("adds a counter from the header button", async () => {
    render(<CountersSettingsPage />);
    await cardOf("Front counter");
    fireEvent.click(screen.getByRole("button", { name: "Add counter" }));
    const form = screen.getByRole("form", { name: "Add a counter" });
    fireEvent.change(within(form).getByLabelText("Counter name"), {
      target: { value: "Dispensary" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Add counter" }),
    );
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith(
        "/terminals/counters",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ label: "Dispensary" }) }),
      ),
    );
  });

  it("warns about a near-duplicate name while typing", async () => {
    render(<CountersSettingsPage />);
    await cardOf("Front counter");
    fireEvent.click(screen.getByRole("button", { name: "Add counter" }));
    fireEvent.change(screen.getByLabelText("Counter name"), {
      target: { value: "Front  Counter" },
    });
    expect(within(screen.getByRole("dialog")).getByRole("note")).toHaveTextContent(
      "The name is close to “Front counter”",
    );
  });

  it("tells the person when a counter with that name already exists, and keeps what they typed", async () => {
    const taken = "A counter named 'Front counter' already exists at this branch";
    (apiJson as jest.Mock).mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST" && path === "/terminals/counters")
        return Promise.reject(new Error(taken));
      if (path === "/terminals/counters") return Promise.resolve([empty, enrolled]);
      if (path === "/terminals/enrollment-codes") return Promise.resolve([code]);
      if (path === "/terminals/offline-journal/sync-status") return Promise.resolve(status(synced));
      return Promise.reject(new Error(path));
    });
    render(<CountersSettingsPage />);
    await cardOf("Front counter");
    fireEvent.click(screen.getByRole("button", { name: "Add counter" }));
    const input = screen.getByLabelText("Counter name");
    fireEvent.change(input, { target: { value: "Front counter" } });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Add counter" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(taken);
    expect(input).toHaveValue("Front counter");
  });
});
