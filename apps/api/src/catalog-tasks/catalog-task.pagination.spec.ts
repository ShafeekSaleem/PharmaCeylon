import { CatalogTaskService } from "./catalog-task.service";

describe("catalog scope pagination", () => {
  it("examines more than 5000 products without restarting from the first page", async () => {
    const rows = Array.from({ length: 5201 }, (_, n) => ({
      id: String(n).padStart(5, "0"),
    }));
    const findMany = jest.fn(async ({ cursor, take }) =>
      rows.filter((r) => !cursor || r.id > cursor.id).slice(0, take),
    );
    const service: any = new CatalogTaskService(
      { product: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const seen: string[] = [];
    for await (const batch of service.pageProducts({ tenantId: "t" }))
      seen.push(...batch.map((r: any) => r.id));
    expect(seen).toEqual(rows.map((r) => r.id));
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { tenantId: "t" } }),
    );
  });
  it("applies beyond 200 tasks, preserves filters and advances past failures", async () => {
    const rows = Array.from({ length: 451 }, (_, n) => ({
      id: String(n).padStart(5, "0"),
    }));
    const findMany = jest.fn(async ({ cursor, take }) =>
      rows.filter((r) => !cursor || r.id > cursor.id).slice(0, take),
    );
    const service = new CatalogTaskService(
      { catalogTask: { findMany } } as never,
      {} as never,
      {} as never,
      { log: jest.fn() } as never,
    );
    const apply = jest
      .spyOn(service, "apply")
      .mockImplementation(async (_t, _u, id) => {
        if (id === "00001") throw new Error("changed");
        return {} as never;
      });
    const result = await service.applySafe("t", "u", { importId: "import-1" });
    expect(result.applied).toBe(450);
    expect(result.failed).toEqual([{ taskId: "00001", reason: "changed" }]);
    expect(apply).toHaveBeenCalledTimes(451);
    for (const [query] of findMany.mock.calls)
      expect(query).toMatchObject({
        where: { tenantId: "t", importId: "import-1", safeToApply: true },
      });
  });
});
