import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { COUNTER_ROUTE_KEY } from "../security/decorators/counter-route.decorator";
import { PERMISSION_KEY } from "../security/decorators/require-permission.decorator";
import { RefundApprovalQueueQueryDto } from "./dto/refund-request.dto";
import { RefundRequestsController } from "./refund-requests.controller";

describe("refund approval inbox boundary", () => {
  it("admits a remote approver without requiring sale execution or sales-history permission", () => {
    for (const method of ["approvalQueue", "approvalDetail"] as const) {
      const handler = RefundRequestsController.prototype[method];
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toEqual([
        "returns.approve",
      ]);
      expect(Reflect.getMetadata(COUNTER_ROUTE_KEY, handler)).toBeUndefined();
    }
  });

  it("accepts bounded pagination and search, rejecting invalid pages and caller-supplied scope", async () => {
    const errors = async (query: object) =>
      (
        await validate(plainToInstance(RefundApprovalQueueQueryDto, query), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((e) => e.property);
    expect(await errors({ page: "2", pageSize: "25", q: "RFR-" })).toEqual([]);
    expect(
      await errors({
        page: "0",
        pageSize: "101",
        tenantId: "someone-else",
        q: "x".repeat(101),
      }),
    ).toEqual(expect.arrayContaining(["page", "pageSize", "tenantId", "q"]));
    expect(await errors({ page: "NaN", pageSize: "1.5" })).toEqual(
      expect.arrayContaining(["page", "pageSize"]),
    );
  });
});
