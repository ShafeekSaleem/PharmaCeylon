import { RoleName } from "@prisma/client";
import { PERMISSION_CATALOG, defaultPermissionsForRole } from "./permission-catalog";

describe("permission catalog defaults", () => {
  it("lets every counter role reach the desktop counter; operation keys still gate each step", () => {
    for (const role of [
      RoleName.owner,
      RoleName.manager,
      RoleName.pharmacist,
      RoleName.cashier,
      RoleName.inventory_clerk,
    ]) {
      expect(defaultPermissionsForRole(role)).toContain("terminal.execute");
    }
    // The gate grants no physical capability on its own: a cashier still can't post a count.
    expect(defaultPermissionsForRole(RoleName.cashier)).not.toContain("stocktakes.review");
    expect(PERMISSION_CATALOG.filter((p) => p.key === "terminal.execute")).toHaveLength(1);
  });
});
