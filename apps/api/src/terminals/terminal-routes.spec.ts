import { PERMISSION_KEY } from "../security/decorators/require-permission.decorator";
import { EnrollmentCodesController } from "./enrollment-codes.controller";
import { OfflineJournalController } from "./journal/offline-journal.controller";
import { TerminalEnrollmentController } from "./terminal-enrollment.controller";

const permissions = (controller: { prototype: object }, method: string) =>
  Reflect.getMetadata(
    PERMISSION_KEY,
    (controller.prototype as Record<string, unknown>)[method] as object,
  ) as string[];

/**
 * The route guard runs before the services, so a route gated tighter than its service expects
 * locks a flow out entirely. Integration specs call the services directly and can't see that.
 */
describe("terminal route permissions", () => {
  it("lets any counter user finish an enrollment; the service demands management unless a code was redeemed", () => {
    expect(permissions(TerminalEnrollmentController, "finishEnrollment")).toEqual([
      "terminal.execute",
    ]);
    expect(permissions(EnrollmentCodesController, "redeem")).toEqual([
      "terminal.execute",
    ]);
  });

  it("keeps the manager-only steps on tenant.management", () => {
    for (const method of [
      "beginEnrollment",
      "counters",
      "createCounter",
      "updateCounter",
      "deleteCounter",
      "revokeEnrollment",
      "retireTerminal",
    ])
      expect(permissions(TerminalEnrollmentController, method)).toEqual(["tenant.management"]);
    for (const method of ["list", "issue", "revoke"])
      expect(permissions(EnrollmentCodesController, method)).toEqual(["tenant.management"]);
    // P5 #51: the counters' journal sync status is for whoever manages the counters.
    expect(permissions(OfflineJournalController, "syncStatus")).toEqual(["tenant.management"]);
    expect(permissions(OfflineJournalController, "sync")).toEqual(["terminal.execute"]);
  });

  it("gates the staff steps at the counter on terminal.execute", () => {
    for (const method of [
      "recordAttendance",
      "beginSession",
      "finishSession",
      "endSession",
      "credential",
      "setPin",
      "prepare",
      "testReceipt",
    ])
      expect(permissions(TerminalEnrollmentController, method)).toEqual(["terminal.execute"]);
  });
});
