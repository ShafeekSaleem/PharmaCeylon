/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import type { LocalShift } from "../../shared/ipc-contract";
import { deviceState, ids, stubPos } from "../test/harness";
import { SupplierCashPayoutTab } from "./SupplierCashPayoutTab";

afterEach(cleanup);

const shift = (): LocalShift => ({
  workSessionId: ids.register2,
  shiftNumber: "S-0412",
  staffUserId: ids.ana,
  staffName: "Sachini Rathnayake",
  openedAt: "2026-11-04T02:32:00.000Z",
  openingCashMinor: 500_000,
  openingCount: [],
  status: "open",
  sync: "synced",
  error: null,
  expectedCashMinor: 2_485_000,
  closedAt: null,
  closedByName: null,
  closingCashCountMinor: null,
  serverExpectedCashMinor: null,
  varianceMinor: null,
  varianceNote: null,
  assistanceReason: null,
  needsManagerPin: false,
  summary: null,
  summaryAt: null,
});

describe("SupplierCashPayoutTab", () => {
  it("shows permission denied state", async () => {
    stubPos({
      cashPayoutsReady: async () => ({
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "Your role can't pay suppliers" },
      }),
    });
    render(
      <SupplierCashPayoutTab
        device={deviceState()}
        shift={shift()}
        online
      />,
    );
    expect(await screen.findByText("Your role can't pay suppliers")).toBeTruthy();
  });

  it("marks a payout short when it exceeds expected cash", async () => {
    stubPos({
      cashPayoutsReady: async () => ({
        ok: true,
        value: [
          {
            cashPayoutId: ids.branch,
            payoutNumber: "SCP-0041",
            supplierName: "Sunshine Healthcare",
            purchaseOrderNumber: null,
            amount: "42775.00",
            paidOn: "2026-11-14",
            reference: null,
            notes: null,
            allocations: [],
            executionApprovalId: ids.session,
            requestedBy: "Kasun",
            approvedBy: "Dilini",
          },
        ],
      }),
    });
    render(
      <SupplierCashPayoutTab
        device={deviceState()}
        shift={shift()}
        online
      />,
    );
    expect(await screen.findByText("Drawer is short")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pay out/ })).toHaveProperty("disabled", true);
  });
});