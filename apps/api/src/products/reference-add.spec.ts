import type { AuditService } from "../audit/audit.service";
import type { ProductMetaService } from "./product-meta.service";
import { ProductsService } from "./products.service";

/**
 * "Add to my products" over the NMRA reference catalog.
 *
 * The dangerous case here is not the refusal, it is the silent success: promoting a register
 * row the shop already sells under its own name creates a second product for one real
 * medicine, and from then on stock, reorder level and sales history are split between the two
 * with nothing to say so. These tests pin the preview that catches that and the acknowledgement
 * gate that stops a UI which forgets to show it.
 */
describe("ProductsService — adding reference products", () => {
  const tenantId = "t1";
  const userId = "u1";

  const referenceRow = {
    id: "ref-1",
    name: "STAMLO 5",
    source: "NMRA",
    rangeStatus: "REFERENCE",
    barcode: "4892345001234",
    registrationNo: "M016695",
    isControlled: false,
    requiresPrescription: true,
    claimedBy: null,
  };

  function makeService(
    opts: { references?: unknown[]; existing?: unknown[] } = {},
  ) {
    const findMany = jest
      .fn()
      // First call loads the reference rows, second the shop products that might collide.
      .mockResolvedValueOnce(opts.references ?? [referenceRow])
      .mockResolvedValueOnce(opts.existing ?? []);
    const prisma = {
      product: {
        findMany,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const meta = {} as unknown as ProductMetaService;
    return {
      service: new ProductsService(prisma as never, audit, meta),
      prisma,
      audit,
    };
  }

  describe("preview", () => {
    it("allows a clean promotion with nothing to review", async () => {
      const { service } = makeService();

      const preview = await service.previewReferenceAdd(tenantId, ["ref-1"]);

      expect(preview).toMatchObject({ addable: 1, needsReview: 0, blocked: 0 });
      expect(preview.items[0].warnings).toEqual([]);
    });

    it("flags a shop product sharing the register row's barcode", async () => {
      const { service } = makeService({
        existing: [
          {
            id: "p1",
            name: "Amlodipine 5mg",
            barcode: "4892345001234",
            registrationNo: null,
            isControlled: false,
            requiresPrescription: true,
          },
        ],
      });

      const preview = await service.previewReferenceAdd(tenantId, ["ref-1"]);

      expect(preview.needsReview).toBe(1);
      expect(preview.items[0].warnings[0]).toContain("same barcode");
      expect(preview.items[0].warnings[0]).toContain("Amlodipine 5mg");
    });

    it("flags a compliance difference against the product it would collide with", async () => {
      const { service } = makeService({
        existing: [
          {
            id: "p1",
            name: "Amlodipine 5mg",
            barcode: "4892345001234",
            registrationNo: null,
            isControlled: false,
            // The register says prescription-only; the shop's record says otherwise.
            requiresPrescription: false,
          },
        ],
      });

      const preview = await service.previewReferenceAdd(tenantId, ["ref-1"]);

      expect(preview.items[0].warnings.join(" ")).toContain(
        "controlled or prescription-only",
      );
    });

    it("counts one duplicate once even when both identifiers collide", async () => {
      const { service } = makeService({
        existing: [
          {
            id: "p1",
            name: "Amlodipine 5mg",
            barcode: "4892345001234",
            registrationNo: "M016695",
            isControlled: false,
            requiresPrescription: true,
          },
        ],
      });

      const preview = await service.previewReferenceAdd(tenantId, ["ref-1"]);

      expect(preview.items[0].warnings).toHaveLength(1);
    });

    it("blocks a row that is already in the range", async () => {
      const { service } = makeService({
        references: [{ ...referenceRow, rangeStatus: "RANGED" }],
      });

      const preview = await service.previewReferenceAdd(tenantId, ["ref-1"]);

      expect(preview).toMatchObject({ addable: 0, blocked: 1 });
      expect(preview.items[0].reason).toContain("already in your products");
    });

    it("blocks a row another product has already claimed", async () => {
      const { service } = makeService({
        references: [{ ...referenceRow, claimedBy: { id: "p9" } }],
      });

      const preview = await service.previewReferenceAdd(tenantId, ["ref-1"]);

      expect(preview.items[0].allowed).toBe(false);
      expect(preview.items[0].reason).toContain("already linked");
    });

    it("returns nothing for an empty selection without hitting the database", async () => {
      const { service, prisma } = makeService();

      const preview = await service.previewReferenceAdd(tenantId, []);

      expect(preview.items).toEqual([]);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });
  });

  describe("apply", () => {
    it("adds a clean row and stamps rangedAt", async () => {
      const { service, prisma, audit } = makeService();

      const result = await service.addReferenceProducts(tenantId, userId, [
        "ref-1",
      ]);

      expect(result.added).toEqual(["ref-1"]);
      const call = prisma.product.updateMany.mock.calls[0][0];
      expect(call.data.rangeStatus).toBe("RANGED");
      expect(call.data.rangedAt).toBeInstanceOf(Date);
      // The filter is the guard against two operators adding the same row at once — the
      // second must be a no-op, not a second rangedAt stamp.
      expect(call.where.rangeStatus).toBe("REFERENCE");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "products.reference_added" }),
      );
    });

    /**
     * The acknowledgement gate. Without it, a UI that forgot to render the review would
     * silently create the duplicate — which is exactly the failure mode the preview exists to
     * prevent, reintroduced by an omission on the client.
     */
    it("holds a flagged row back when the warnings were not acknowledged", async () => {
      const { service, prisma } = makeService({
        existing: [
          {
            id: "p1",
            name: "Amlodipine 5mg",
            barcode: "4892345001234",
            registrationNo: null,
            isControlled: false,
            requiresPrescription: true,
          },
        ],
      });

      const result = await service.addReferenceProducts(tenantId, userId, [
        "ref-1",
      ]);

      expect(result.added).toEqual([]);
      expect(result.held[0].reason).toContain("same barcode");
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });

    it("adds the same flagged row once the operator has acknowledged it", async () => {
      const { service } = makeService({
        existing: [
          {
            id: "p1",
            name: "Amlodipine 5mg",
            barcode: "4892345001234",
            registrationNo: null,
            isControlled: false,
            requiresPrescription: true,
          },
        ],
      });

      const result = await service.addReferenceProducts(
        tenantId,
        userId,
        ["ref-1"],
        {
          acknowledgeWarnings: true,
        },
      );

      expect(result.added).toEqual(["ref-1"]);
    });

    it("holds a blocked row no matter what the caller acknowledges", async () => {
      const { service, prisma } = makeService({
        references: [{ ...referenceRow, claimedBy: { id: "p9" } }],
      });

      const result = await service.addReferenceProducts(
        tenantId,
        userId,
        ["ref-1"],
        {
          acknowledgeWarnings: true,
        },
      );

      expect(result.added).toEqual([]);
      expect(result.held).toHaveLength(1);
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });
  });
});
