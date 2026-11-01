import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TerminalCounterView, TerminalEnrollmentCodeView } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
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

beforeEach(() => {
  (apiJson as jest.Mock).mockReset();
  (apiJson as jest.Mock).mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST" && path === "/terminals/enrollment-codes")
      return Promise.resolve({ code: "ABCDE-FGHJK", view: code });
    if (init?.method === "POST") return Promise.resolve(undefined);
    if (path === "/terminals/counters") return Promise.resolve([empty, enrolled]);
    if (path === "/terminals/enrollment-codes") return Promise.resolve([code]);
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
