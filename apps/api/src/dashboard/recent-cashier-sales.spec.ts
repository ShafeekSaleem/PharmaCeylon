import { SalesService } from "../sales/sales.service";

it("filters the operator before applying the recent-sales limit", async () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const service = new SalesService({ sale: { findMany } } as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  await service.listSales("tenant", "branch", 50, "cashier");
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ tenantId: "tenant", branchId: "branch", soldBy: "cashier" }), take: 50,
  }));
});
