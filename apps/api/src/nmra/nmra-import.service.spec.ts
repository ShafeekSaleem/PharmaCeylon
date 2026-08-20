import { AuditService } from "../audit/audit.service";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import type { NmraProductRow } from "./nmra-normalize";
import { NmraImportService } from "./nmra-import.service";

/**
 * Covers the two catalog-taxonomy-redesign scenarios that live entirely inside
 * `ensureNmraTaxonomy` (private — exercised directly, a pragmatic tradeoff over mocking a
 * full Excel/CSV buffer through the public `upsert()` entry point):
 *   1. NMRA import still creates/updates Schedule/Dosage Form/Registration Type mappings.
 *   2. NMRA import also leaves every product with a valid (fallback, if nothing else) primary
 *      COMMERCIAL classification — without ever touching the regulatory maps above.
 */
describe("NmraImportService.ensureNmraTaxonomy", () => {
  const tenantId = "tenant-1";

  type PrismaMock = {
    productCategory: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      createMany: jest.Mock;
    };
    productCategoryMap: {
      findMany: jest.Mock;
      createMany: jest.Mock;
    };
  };

  function makePrisma(): PrismaMock {
    let createCounter = 0;
    return {
      productCategory: {
        // Only the commercial "Unclassified Medicines" fallback pre-exists; everything else
        // (regulatory dimension roots, commercial template) is created fresh by this run.
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.canonicalKey === "MEDICINES_UNCLASSIFIED") {
            return Promise.resolve({ id: "unclassified-id" });
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: `created-${createCounter++}`, ...data }),
        ),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      productCategoryMap: {
        findMany: jest.fn().mockResolvedValue([]), // no product has a primary commercial map yet
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  function makeService(prisma: PrismaMock) {
    const audit = { log: jest.fn() } as unknown as AuditService;
    const categoryTaxonomy = new CategoryTaxonomyService(prisma as never);
    return new NmraImportService(prisma as never, audit, categoryTaxonomy);
  }

  const row: NmraProductRow = {
    id: "row-1",
    sku: "SKU-1",
    name: "PARACETAMOL 500MG",
    brandName: "PANADOL",
    genericName: "PARACETAMOL",
    manufacturer: "GSK",
    dosageForm: "Tablet",
    dosageFormGroup: "Tablet",
    strength: "500mg",
    unit: "Tablet",
    packSize: "10s",
    packType: "Blister",
    barcode: null,
    registrationNo: "REG-1",
    registrationDate: null,
    schedule: "II A",
    scheduleGroup: "II A",
    regType: "Full",
    dossierNo: null,
    countryOfOrigin: null,
    localAgent: null,
    isControlled: false,
    requiresPrescription: false,
    isUnbranded: false,
    isActive: true,
    reorderLevel: 0,
  };

  it("creates Dosage Form / NMRA Schedule / Registration Type maps tagged with the right dimension", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);
    const byReg = new Map([["REG-1", { id: "prod-1", registrationNo: "REG-1", sku: "SKU-1", barcode: null }]]);

    await (service as unknown as { ensureNmraTaxonomy: Function }).ensureNmraTaxonomy(tenantId, [row], byReg);

    const allMapRows = prisma.productCategoryMap.createMany.mock.calls.flatMap((c) => c[0].data);
    const regulatoryMaps = allMapRows.filter((m) => m.productId === "prod-1" && m.dimension !== "COMMERCIAL");
    expect(regulatoryMaps).toHaveLength(3);
    expect(regulatoryMaps.map((m) => m.dimension).sort()).toEqual(
      ["DOSAGE_FORM", "NMRA_SCHEDULE", "REGISTRATION_TYPE"].sort(),
    );
    for (const m of regulatoryMaps) {
      expect(m.assignmentSource).toBe("NMRA_IMPORT");
      expect(m.isPrimary).toBe(true);
    }

    // Regulatory dimension roots created with the right dimension tag (not string-name matched).
    const rootCreates = prisma.productCategory.create.mock.calls
      .map((c) => c[0].data)
      .filter((d) => d.parentCategoryId === null && d.dimension !== "COMMERCIAL");
    expect(rootCreates.map((d) => d.dimension).sort()).toEqual(
      ["DOSAGE_FORM", "NMRA_SCHEDULE", "REGISTRATION_TYPE"].sort(),
    );
  });

  it("also assigns the product a commercial classification, without overwriting NMRA-sourced regulatory data", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);
    const byReg = new Map([["REG-1", { id: "prod-1", registrationNo: "REG-1", sku: "SKU-1", barcode: null }]]);

    await (service as unknown as { ensureNmraTaxonomy: Function }).ensureNmraTaxonomy(tenantId, [row], byReg);

    const allMapRows = prisma.productCategoryMap.createMany.mock.calls.flatMap((c) => c[0].data);
    const commercialMap = allMapRows.find((m) => m.productId === "prod-1" && m.dimension === "COMMERCIAL");
    expect(commercialMap).toEqual(
      expect.objectContaining({
        categoryId: "unclassified-id",
        isPrimary: true,
        assignmentSource: "SYSTEM_DEFAULT",
      }),
    );

    // The regulatory maps are still present and untouched by the commercial-assignment step.
    const regulatoryMaps = allMapRows.filter((m) => m.productId === "prod-1" && m.dimension !== "COMMERCIAL");
    expect(regulatoryMaps).toHaveLength(3);
  });
});
