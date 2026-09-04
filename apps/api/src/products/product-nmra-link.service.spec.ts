import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ProductNmraLinkService } from "./product-nmra-link.service";

/**
 * A small in-memory Prisma double rather than per-call `jest.fn()` stubs — link/unlink touch
 * five delegates across two transactions, and the thing actually worth verifying is that
 * unlink puts every one of those rows back exactly as they were, which a call-count assertion
 * can't show. The double is tenant-scoped for real (a `where.tenantId` that doesn't match
 * genuinely finds nothing), so the cross-tenant tests exercise the real guard, not a mock of it.
 */

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Row | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (cond === null) {
      if (row[key] != null) return false;
      continue;
    }
    if (typeof cond === "object" && cond !== null) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in) {
        if (!c.in.includes(row[key])) return false;
        continue;
      }
      if ("not" in c) {
        if (row[key] === c.not) return false;
        continue;
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

function makeFakeDb() {
  const products: Row[] = [];
  const categoryMaps: Row[] = [];
  const tagMaps: Row[] = [];
  const aliases: Row[] = [];
  const links: Row[] = [];

  const product = {
    findFirst: jest.fn(async ({ where }: { where: Row }) => products.find((p) => matchesWhere(p, where)) ?? null),
    findMany: jest.fn(async ({ where }: { where: Row }) => products.filter((p) => matchesWhere(p, where))),
    count: jest.fn(async ({ where }: { where: Row }) => products.filter((p) => matchesWhere(p, where)).length),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const p = products.find((r) => matchesWhere(r, where));
      if (!p) throw new Error("product not found");
      Object.assign(p, data);
      return p;
    }),
  };

  const productCategoryMap = {
    findMany: jest.fn(async ({ where }: { where: Row }) => categoryMaps.filter((m) => matchesWhere(m, where))),
    findFirst: jest.fn(async ({ where }: { where: Row }) => categoryMaps.find((m) => matchesWhere(m, where)) ?? null),
    deleteMany: jest.fn(async ({ where }: { where: Row }) => {
      const before = categoryMaps.length;
      for (let i = categoryMaps.length - 1; i >= 0; i--) {
        if (matchesWhere(categoryMaps[i], where)) categoryMaps.splice(i, 1);
      }
      return { count: before - categoryMaps.length };
    }),
    createMany: jest.fn(async ({ data }: { data: Row[] }) => {
      categoryMaps.push(...data.map((d) => ({ ...d })));
      return { count: data.length };
    }),
    upsert: jest.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const key = where.tenantId_productId_categoryId as Row;
      const existing = categoryMaps.find(
        (m) => m.tenantId === key.tenantId && m.productId === key.productId && m.categoryId === key.categoryId,
      );
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const created = { ...create };
      categoryMaps.push(created);
      return created;
    }),
  };

  const productTagMap = {
    findMany: jest.fn(async ({ where }: { where: Row }) => tagMaps.filter((m) => matchesWhere(m, where))),
    createMany: jest.fn(async ({ data }: { data: Row[] }) => {
      tagMaps.push(...data.map((d) => ({ ...d })));
      return { count: data.length };
    }),
    deleteMany: jest.fn(async ({ where }: { where: Row }) => {
      const before = tagMaps.length;
      for (let i = tagMaps.length - 1; i >= 0; i--) {
        if (matchesWhere(tagMaps[i], where)) tagMaps.splice(i, 1);
      }
      return { count: before - tagMaps.length };
    }),
  };

  const productAlias = {
    upsert: jest.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const key = where.tenantId_productId_aliasText as Row;
      const existing = aliases.find(
        (a) => a.tenantId === key.tenantId && a.productId === key.productId && a.aliasText === key.aliasText,
      );
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const created = { ...create };
      aliases.push(created);
      return created;
    }),
    deleteMany: jest.fn(async ({ where }: { where: Row }) => {
      const before = aliases.length;
      for (let i = aliases.length - 1; i >= 0; i--) {
        if (matchesWhere(aliases[i], where)) aliases.splice(i, 1);
      }
      return { count: before - aliases.length };
    }),
  };

  const productNmraLink = {
    findFirst: jest.fn(async ({ where }: { where: Row }) => links.find((l) => matchesWhere(l, where)) ?? null),
    create: jest.fn(async ({ data }: { data: Row }) => {
      const created = { id: `link-${links.length + 1}`, ...data };
      links.push(created);
      return created;
    }),
    delete: jest.fn(async ({ where }: { where: Row }) => {
      const idx = links.findIndex((l) => matchesWhere(l, where));
      if (idx === -1) throw new Error("link not found");
      const [removed] = links.splice(idx, 1);
      return removed;
    }),
  };

  const prisma = {
    product,
    productCategoryMap,
    productTagMap,
    productAlias,
    productNmraLink,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaLike)),
  };
  const prismaLike = prisma as unknown as Row;

  return { prisma, products, categoryMaps, tagMaps, aliases, links };
}

const T1 = "tenant-1";
const T2 = "tenant-2";
const UNCLASSIFIED_ID = "cat-unclassified";

function baseProduct(overrides: Row): Row {
  return {
    tenantId: T1,
    barcode: null,
    brandName: null,
    genericName: null,
    dosageForm: null,
    strength: null,
    unit: null,
    packSize: null,
    packType: null,
    manufacturer: null,
    localAgent: null,
    countryOfOrigin: null,
    storage: null,
    shelfLife: null,
    registrationNo: null,
    registrationDate: null,
    schedule: null,
    regType: null,
    dossierNo: null,
    isControlled: false,
    requiresPrescription: false,
    rangeStatus: "RANGED",
    source: "MANUAL",
    nmraReferenceId: null,
    ...overrides,
  };
}

function makeService(db: ReturnType<typeof makeFakeDb>) {
  const taxonomy = {
    setPrimaryCommercialCategory: jest.fn().mockResolvedValue(undefined),
    commercialCanonicalIds: jest.fn().mockResolvedValue(new Map([["MEDICINES_UNCLASSIFIED", UNCLASSIFIED_ID]])),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new ProductNmraLinkService(
    db.prisma as never,
    taxonomy as never,
    audit as never,
  );
  return { service, taxonomy, audit };
}

describe("ProductNmraLinkService.link — guards", () => {
  it("rejects linking a product to itself", async () => {
    const db = makeFakeDb();
    db.products.push(baseProduct({ id: "p1", name: "Panadol" }));
    const { service } = makeService(db);

    await expect(service.link(T1, "user-1", "p1", "p1")).rejects.toThrow(BadRequestException);
  });

  it("cannot link across tenants — a reference row in another tenant is simply not found", async () => {
    const db = makeFakeDb();
    db.products.push(baseProduct({ id: "shop-1", name: "Panadol", tenantId: T1 }));
    db.products.push(
      baseProduct({
        id: "ref-1",
        name: "PARACETAMOL TABLETS BP 500MG",
        tenantId: T2,
        rangeStatus: "REFERENCE",
        source: "NMRA",
      }),
    );
    const { service } = makeService(db);

    await expect(service.link(T1, "user-1", "shop-1", "ref-1")).rejects.toThrow(NotFoundException);
  });

  it("rejects linking to one of the shop's own products, not a reference row", async () => {
    const db = makeFakeDb();
    db.products.push(baseProduct({ id: "shop-1", name: "Panadol" }));
    db.products.push(baseProduct({ id: "shop-2", name: "Some other product", rangeStatus: "RANGED" }));
    const { service } = makeService(db);

    await expect(service.link(T1, "user-1", "shop-1", "shop-2")).rejects.toThrow(BadRequestException);
  });

  it("rejects a reference row already claimed by another product", async () => {
    const db = makeFakeDb();
    db.products.push(baseProduct({ id: "shop-1", name: "Panadol" }));
    db.products.push(
      baseProduct({ id: "ref-1", name: "PARACETAMOL", rangeStatus: "REFERENCE", source: "NMRA" }),
    );
    db.products.push(
      baseProduct({ id: "shop-2", name: "Already linked", nmraReferenceId: "ref-1" }),
    );
    const { service } = makeService(db);

    await expect(service.link(T1, "user-1", "shop-1", "ref-1")).rejects.toThrow(ConflictException);
  });

  it("rejects re-linking a product that is already linked", async () => {
    const db = makeFakeDb();
    db.products.push(baseProduct({ id: "shop-1", name: "Panadol", nmraReferenceId: "ref-0" }));
    db.products.push(
      baseProduct({ id: "ref-1", name: "PARACETAMOL", rangeStatus: "REFERENCE", source: "NMRA" }),
    );
    const { service } = makeService(db);

    await expect(service.link(T1, "user-1", "shop-1", "ref-1")).rejects.toThrow(ConflictException);
  });
});

describe("ProductNmraLinkService.link then unlink", () => {
  function seedLinkableFixture(db: ReturnType<typeof makeFakeDb>) {
    db.products.push(
      baseProduct({
        id: "shop-1",
        name: "Panadol 500mg Tablet",
        brandName: "Panadol",
        barcode: "SHOP-BARCODE",
        genericName: "Paracetamol",
        dosageForm: "Tablet",
        strength: "500mg",
        manufacturer: null,
        isControlled: false,
        requiresPrescription: false,
      }),
    );
    db.products.push(
      baseProduct({
        id: "ref-1",
        name: "PARACETAMOL TABLETS BP 500MG",
        brandName: "GSK Paracetamol",
        barcode: null,
        genericName: "PARACETAMOL TABLETS BP 500MG",
        dosageForm: "TABLET",
        strength: "500MG",
        manufacturer: "GSK Pharmaceuticals",
        registrationNo: "M001234",
        schedule: "II A",
        isControlled: true,
        rangeStatus: "REFERENCE",
        source: "NMRA",
      }),
    );
    db.categoryMaps.push({
      tenantId: T1,
      productId: "ref-1",
      categoryId: "cat-panadol",
      dimension: "COMMERCIAL",
      isPrimary: true,
    });
    db.categoryMaps.push({
      tenantId: T1,
      productId: "ref-1",
      categoryId: "cat-tablet",
      dimension: "DOSAGE_FORM",
      isPrimary: true,
    });
    db.tagMaps.push({ tenantId: T1, productId: "ref-1", tagId: "tag-nmra-registered" });
  }

  it("applies the field plan, absorbs categories/tags, and snapshots what it changed", async () => {
    const db = makeFakeDb();
    seedLinkableFixture(db);
    const { service, taxonomy, audit } = makeService(db);

    await service.link(T1, "user-1", "shop-1", "ref-1");

    const shop = db.products.find((p) => p.id === "shop-1")!;
    expect(shop.name).toBe("PARACETAMOL TABLETS BP 500MG");
    expect(shop.registrationNo).toBe("M001234");
    expect(shop.schedule).toBe("II A");
    expect(shop.isControlled).toBe(true);
    expect(shop.manufacturer).toBe("GSK Pharmaceuticals");
    expect(shop.barcode).toBe("SHOP-BARCODE"); // never overwritten
    expect(shop.nmraReferenceId).toBe("ref-1");

    expect(db.aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aliasText: "Panadol 500mg Tablet", aliasType: "shop_name" }),
        expect.objectContaining({ aliasText: "Panadol", aliasType: "shop_brand" }),
      ]),
    );

    expect(
      db.categoryMaps.some(
        (m) => m.productId === "shop-1" && m.dimension === "DOSAGE_FORM" && m.categoryId === "cat-tablet",
      ),
    ).toBe(true);
    expect(db.tagMaps.some((m) => m.productId === "shop-1" && m.tagId === "tag-nmra-registered")).toBe(
      true,
    );

    expect(taxonomy.setPrimaryCommercialCategory).toHaveBeenCalledWith(T1, "shop-1", "cat-panadol", {
      assignmentSource: "NMRA_LINK",
    });

    const link = db.links.find((l) => l.productId === "shop-1")!;
    expect(link).toBeDefined();
    const snapshot = link.previousValues as { scalars: { name: string; isControlled: boolean } };
    expect(snapshot.scalars.name).toBe("Panadol 500mg Tablet");
    expect(snapshot.scalars.isControlled).toBe(false);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "products.nmra_link", entityId: "shop-1" }),
    );
  });

  it("unlink restores every scalar, alias, category map and tag the link touched", async () => {
    const db = makeFakeDb();
    seedLinkableFixture(db);
    const { service, audit } = makeService(db);

    await service.link(T1, "user-1", "shop-1", "ref-1");
    await service.unlink(T1, "user-1", "shop-1");

    const shop = db.products.find((p) => p.id === "shop-1")!;
    expect(shop.name).toBe("Panadol 500mg Tablet");
    expect(shop.brandName).toBe("Panadol");
    expect(shop.registrationNo).toBeNull();
    expect(shop.schedule).toBeNull();
    expect(shop.isControlled).toBe(false);
    expect(shop.manufacturer).toBeNull();
    expect(shop.nmraReferenceId).toBeNull();

    expect(db.aliases.some((a) => a.aliasText === "Panadol 500mg Tablet")).toBe(false);
    expect(db.aliases.some((a) => a.aliasText === "Panadol" && a.aliasType === "shop_brand")).toBe(false);

    // The shop had no DOSAGE_FORM map before linking, so unlink leaves none.
    expect(db.categoryMaps.some((m) => m.productId === "shop-1" && m.dimension === "DOSAGE_FORM")).toBe(
      false,
    );
    // It had no commercial category before either — restored to Unclassified, never left bare.
    const commercial = db.categoryMaps.find(
      (m) => m.productId === "shop-1" && m.dimension === "COMMERCIAL",
    )!;
    expect(commercial).toBeDefined();
    expect(commercial.categoryId).toBe(UNCLASSIFIED_ID);

    expect(db.tagMaps.some((m) => m.productId === "shop-1" && m.tagId === "tag-nmra-registered")).toBe(
      false,
    );
    expect(db.links.some((l) => l.productId === "shop-1")).toBe(false);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "products.nmra_unlink", entityId: "shop-1" }),
    );
  });

  it("never adopts over a deliberate existing commercial category, so unlink leaves it untouched", async () => {
    // "Adopted only when the product has none, or is still in Unclassified — a deliberate
    // merchandising choice is never overwritten" (field-ownership table). Since the gate
    // itself refuses to touch a real category, there is no "adopt, then restore a different
    // one" path to exercise — this pins that link() leaves it alone in the first place, and
    // unlink's unconditional re-affirm of `commercialCategoryIdBefore` is a harmless no-op.
    const db = makeFakeDb();
    seedLinkableFixture(db);
    db.categoryMaps.push({
      tenantId: T1,
      productId: "shop-1",
      categoryId: "cat-personal-care",
      dimension: "COMMERCIAL",
      isPrimary: true,
      category: { canonicalKey: "PERSONAL_CARE" },
    });
    const { service, taxonomy } = makeService(db);

    await service.link(T1, "user-1", "shop-1", "ref-1");
    expect(taxonomy.setPrimaryCommercialCategory).not.toHaveBeenCalled();

    await service.unlink(T1, "user-1", "shop-1");

    const commercialMaps = db.categoryMaps.filter(
      (m) => m.productId === "shop-1" && m.dimension === "COMMERCIAL",
    );
    expect(commercialMaps).toHaveLength(1);
    expect(commercialMaps[0].categoryId).toBe("cat-personal-care");
  });

  it("throws when a product isn't linked", async () => {
    const db = makeFakeDb();
    db.products.push(baseProduct({ id: "shop-1", name: "Panadol" }));
    const { service } = makeService(db);

    await expect(service.unlink(T1, "user-1", "shop-1")).rejects.toThrow(NotFoundException);
  });

  it("unlink is tenant-scoped — another tenant's product id is not found here", async () => {
    const db = makeFakeDb();
    seedLinkableFixture(db);
    const { service } = makeService(db);
    await service.link(T1, "user-1", "shop-1", "ref-1");

    await expect(service.unlink(T2, "user-1", "shop-1")).rejects.toThrow(NotFoundException);
  });
});
