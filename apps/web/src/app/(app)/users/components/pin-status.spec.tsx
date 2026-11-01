import { render, screen } from "@testing-library/react";
import type { SecurityInfo } from "../types";
import { PinStatus } from "./manage-staff-modal";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));

const security = (overrides: Partial<SecurityInfo> = {}): SecurityInfo => ({
  pin: { isSet: true, isLocked: false, lockedUntil: null, failedAttempts: 0, version: 3 },
  preparedCounters: [],
  sessions: [],
  ...overrides,
});

const counter = (label: string, current: boolean) => ({
  terminalId: label,
  branchId: "b1",
  branchName: "Main",
  counterLabel: label,
  preparedAt: "2026-10-31T09:00:00.000Z",
  pinVersion: current ? 3 : 2,
  current,
});

it("shows the PIN version and which counters are prepared or stale", () => {
  render(
    <PinStatus
      security={security({ preparedCounters: [counter("Front", true), counter("Back", false)] })}
    />,
  );
  expect(screen.getByText("Set")).toBeInTheDocument();
  expect(screen.getByText(/version 3/)).toBeInTheDocument();
  expect(screen.getByText(/Front/).closest("li")).toHaveTextContent("prepared");
  expect(screen.getByText(/Back/).closest("li")).toHaveTextContent(
    "needs preparing again since their PIN changed",
  );
  expect(screen.getByText(/can't unlock for them/)).toBeInTheDocument();
});

it("explains that the PIN is set at the counter when there isn't one", () => {
  render(
    <PinStatus
      security={security({
        pin: { isSet: false, isLocked: false, lockedUntil: null, failedAttempts: 0, version: 1 },
      })}
    />,
  );
  expect(screen.getByText("Not set")).toBeInTheDocument();
  expect(screen.getByText(/when they first sign in at a counter/)).toBeInTheDocument();
});
