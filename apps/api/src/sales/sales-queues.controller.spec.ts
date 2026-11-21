import { PERMISSION_KEY } from "../security/decorators/require-permission.decorator";
import { SalesQueuesController } from "./sales-queues.controller";

const permissionsFor = (method: "incidentNotes" | "paymentRecovery" | "collectedMoney") =>
  Reflect.getMetadata(PERMISSION_KEY, SalesQueuesController.prototype[method]);

describe("SalesQueuesController permissions", () => {
  it.each(["incidentNotes", "paymentRecovery", "collectedMoney"] as const)(
    "%s requires tenant.management",
    (method) => {
      expect(permissionsFor(method)).toEqual(["tenant.management"]);
    },
  );
});