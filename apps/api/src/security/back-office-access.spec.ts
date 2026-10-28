import { ConfigService } from "@nestjs/config";
import { RoleName } from "@prisma/client";
import { PermissionsService } from "./permissions.service";

describe("back-office web scope", () => {
  const findFirst = jest.fn();
  const findMany = jest.fn();
  const service = new PermissionsService(
    { role: { findFirst }, rolePermission: { findMany } } as never,
    { get: () => 30 } as unknown as ConfigService,
  );

  beforeEach(() => jest.clearAllMocks());

  it("resolves custom-role access from the tenant-scoped setting, independently of API grants", async () => {
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([
      { permissionKey: "sales.pos_use" },
      { permissionKey: "inventory.view" },
    ]);
    const candidates = [{ role: RoleName.custom, roleId: "custom-role" }];
    expect(await service.resolveBackOfficeAccess("tenant-a", candidates)).toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-a",
        id: { in: ["custom-role"] },
        backOfficeAccess: true,
      },
      select: { id: true },
    });
    expect(await service.resolveGrantedKeys(candidates)).toEqual(
      new Set(["sales.pos_use", "inventory.view"]),
    );
    findFirst.mockResolvedValue({ id: "custom-role" });
    expect(await service.resolveBackOfficeAccess("tenant-a", candidates)).toBe(true);
  });

  it("does not infer access from a custom role with no persisted role id", async () => {
    expect(await service.resolveBackOfficeAccess("tenant-a", [{ role: RoleName.custom }])).toBe(
      false,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("uses cashier-denied and manager-allowed defaults only for legacy mappings", async () => {
    expect(await service.resolveBackOfficeAccess("tenant-a", [{ role: RoleName.cashier }])).toBe(
      false,
    );
    expect(await service.resolveBackOfficeAccess("tenant-a", [{ role: RoleName.manager }])).toBe(
      true,
    );
    findFirst.mockResolvedValue(null);
    expect(
      await service.resolveBackOfficeAccess("tenant-a", [
        { role: RoleName.manager, roleId: "edited" },
      ]),
    ).toBe(false);
  });
});
