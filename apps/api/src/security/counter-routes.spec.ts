import { AuthController } from "../auth/auth.controller";
import { CustomersController } from "../customers/customers.controller";
import { InventoryController } from "../inventory/inventory.controller";
import { PrescriptionsController } from "../customers/prescriptions.controller";
import { RefundRequestsController } from "../sales/refund-requests.controller";
import { SalesController } from "../sales/sales.controller";
import { CounterWorkController } from "../terminal-commands/counter-work.controller";
import { TerminalCommandsController } from "../terminal-commands/terminal-commands.controller";
import { OfflineActivationController } from "../terminals/offline-activation.controller";
import { OfflineAssignmentController } from "../terminals/offline-assignment.controller";
import { OfflineAuthorityController } from "../terminals/offline-authority.controller";
import { TerminalEnrollmentController } from "../terminals/terminal-enrollment.controller";
import { TillShiftsController } from "../terminals/shifts/till-shifts.controller";
import { COUNTER_ROUTE_KEY } from "./decorators/counter-route.decorator";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator";

type Controller = { name: string; prototype: object };

const marked = (controller: Controller, method: string, key: string) =>
  Reflect.getMetadata(
    key,
    (controller.prototype as Record<string, unknown>)[method] as object,
  ) === true;

/**
 * D-W5: a PIN opens a login that reaches only the routes the desktop counter calls. The list is
 * deliberately exact, so widening it is a reviewed change to this spec, not a side effect.
 */
describe("routes a PIN-opened counter login may call", () => {
  const counterRoutes: Array<[Controller, string[]]> = [
    [AuthController, ["logout"]],
    [
      SalesController,
      [
        "posCatalog",
        "listApprovers",
        "listDiscountApprovers",
        "listRefundApprovers",
        "hold",
        "listHolds",
        "recallHold",
        "checkout",
        "resolveCheckout",
        // The Returns page: find the sale, what is still returnable, and today's refunds.
        "posByInvoice",
        "getReturnable",
        "history",
        "listRefunds",
      ],
    ],
    // `approve` takes the approver co-sign on the counter (P2b #103); `prepare` is the Returns page.
    [RefundRequestsController, ["list", "prepare", "approve"]],
    [CustomersController, ["search", "getOne"]],
    [PrescriptionsController, ["search", "getOne"]],
    [TerminalCommandsController, ["prepare", "execute", "cosign"]],
    [CounterWorkController, ["list"]],
    // The Stock page reads; every stock change goes through the signed command above.
    [InventoryController, ["stockByProduct", "productStock", "writeOffPolicy"]],
    [OfflineAssignmentController, ["view"]],
    [TillShiftsController, ["current", "list", "detail", "open", "close"]],
    [OfflineAuthorityController, ["prepare", "issue"]],
    [
      TerminalEnrollmentController,
      [
        "enrollmentStatus",
        "recordAttendance",
        "endSession",
        "testReceipt",
        "credential",
        "setPin",
        "prepare",
      ],
    ],
  ];

  it.each(counterRoutes)("marks exactly the counter's own %p routes", (controller, methods) => {
    const all = Object.getOwnPropertyNames(controller.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(all.filter((name) => marked(controller, name, COUNTER_ROUTE_KEY)).sort()).toEqual(
      [...methods].sort(),
    );
  });

  it("keeps opening sessions, offline activation and account changes password-only", () => {
    for (const method of ["beginSession", "finishSession", "beginEnrollment", "finishEnrollment"])
      expect(marked(TerminalEnrollmentController, method, COUNTER_ROUTE_KEY)).toBe(false);
    for (const method of ["prepare", "activate"])
      expect(marked(OfflineActivationController, method, COUNTER_ROUTE_KEY)).toBe(false);
    for (const method of ["logoutAll", "changePassword", "me", "revokeMySession"])
      expect(marked(AuthController, method, COUNTER_ROUTE_KEY)).toBe(false);
  });

  it("leaves only the two PIN sign-in steps public on the terminal controller", () => {
    const all = Object.getOwnPropertyNames(TerminalEnrollmentController.prototype);
    expect(
      all.filter((name) => marked(TerminalEnrollmentController, name, IS_PUBLIC_KEY)).sort(),
    ).toEqual(["beginPinSession", "finishPinSession"]);
  });
});
