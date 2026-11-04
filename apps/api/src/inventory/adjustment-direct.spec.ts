import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AdjustmentService } from "./adjustment.service";
import { NewBatchForAdjustmentDto, StockAdjustmentDto } from "./dto/stock-adjustment.dto";

const user: RequestUser = {
  tenantId: "tenant-1",
  userId: "manager-1",
  tokenVersion: 0,
  branchRoles: [],
  email: "manager@test",
  fullName: "Manager",
  authMethod: "cookie",
};
const BRANCH = "branch-1";
const KEY = "adjustment-3c9e";
/** As the validation pipe hands it over: a class instance, not a plain object. */
const dto = (fields: Partial<StockAdjustmentDto> = {}) =>
  Object.assign(new StockAdjustmentDto(), {
    productId: "product-1",
    batchId: "batch-1",
    qty: 2,
    kind: "found",
    reason: "Behind the shelf",
    ...fields,
  });
const plain = (value: object) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

function setup() {
  let posted = 0;
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    batch: { findFirst: jest.fn().mockResolvedValue({ id: "batch-1", costPrice: new Prisma.Decimal("10.00") }) },
    tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    stockLedger: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const inventory = {
    adjustment: jest.fn(async (_tenantId: string, _branchId: string, _actor: unknown, body: StockAdjustmentDto,
      _execution?: { tx: unknown }) => ({
      ok: true,
      referenceId: `ref-${++posted}`,
      batchId: body.batchId ?? "batch-new",
    })),
  };
  const actor = { has: jest.fn().mockReturnValue(true), canSelfApprove: true };
  const access = { resolveLive: jest.fn().mockResolvedValue(actor) };
  const service = new AdjustmentService(
    prisma as never,
    inventory as never,
    {} as never,
    {} as never,
    access as never,
    {} as never,
  );
  /** The key as an earlier request recorded it: its body, and the movement it posted. */
  const recorded = (requestBody: unknown, moved = { branchId: BRANCH, batchId: "batch-1" }) => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue({ resourceId: "ref-original", requestBody });
    prisma.stockLedger.findFirst.mockResolvedValue(moved);
  };
  return { service, prisma, tx, inventory, actor, recorded };
}

describe("direct stock adjustments and Idempotency-Key", () => {
  it("posts every request sent without a key, as before", async () => {
    const { service, prisma, tx, inventory } = setup();
    const first = await service.postDirect(user, BRANCH, dto());
    const second = await service.postDirect(user, BRANCH, dto());
    expect(first).toEqual({ held: false, ok: true, referenceId: "ref-1", batchId: "batch-1" });
    expect(second.referenceId).toBe("ref-2");
    expect(inventory.adjustment).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.idempotencyRecord.create).not.toHaveBeenCalled();
    expect(prisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
  });

  it("records the key and the body as sent with the movement, under the key's lock", async () => {
    const { service, tx, inventory } = setup();
    const body = dto();
    const result = await service.postDirect(user, BRANCH, body, `  ${KEY}  `);
    expect(result).toEqual({ held: false, ok: true, referenceId: "ref-1", batchId: "batch-1" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]).toContain(`stock_adjustment:tenant-1:manager-1:${KEY}`);
    // The lock is taken before the adjustment is posted, so a resend waits for it.
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(inventory.adjustment.mock.invocationCallOrder[0]!);
    expect(inventory.adjustment.mock.calls[0]![4]).toMatchObject({ tx });
    expect(tx.idempotencyRecord.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-1",
        userId: "manager-1",
        scope: "stock_adjustment",
        idempotencyKey: KEY,
        resourceId: "ref-1",
        requestBody: plain(body),
      },
    });
    expect(Object.getPrototypeOf(tx.idempotencyRecord.create.mock.calls[0]![0].data.requestBody)).toBe(Object.prototype);
  });

  it("returns the first result to a resend of the same body, moving nothing", async () => {
    const { service, prisma, inventory, recorded } = setup();
    // jsonb hands the body back with its keys reordered.
    const { reason, ...rest } = plain(dto());
    recorded({ reason, ...rest });
    await expect(service.postDirect(user, BRANCH, dto(), KEY)).resolves.toEqual({
      held: false,
      ok: true,
      referenceId: "ref-original",
      batchId: "batch-1",
    });
    expect(prisma.stockLedger.findFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", referenceType: "adjustment", referenceId: "ref-original" },
      select: { branchId: true, batchId: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(inventory.adjustment).not.toHaveBeenCalled();
  });

  it("returns the batch a first request opened to its resend", async () => {
    const { service, inventory, recorded } = setup();
    const body = dto({
      batchId: undefined,
      kind: "opening",
      reason: undefined,
      newBatch: Object.assign(new NewBatchForAdjustmentDto(), {
        batchNo: "N-1",
        expiryDate: "2027-06-30",
        costPrice: 12.5,
        sellingPrice: 15,
      }),
    });
    recorded(plain(body), { branchId: BRANCH, batchId: "batch-opened" });
    await expect(service.postDirect(user, BRANCH, body, KEY)).resolves.toMatchObject({
      referenceId: "ref-original",
      batchId: "batch-opened",
    });
    expect(inventory.adjustment).not.toHaveBeenCalled();
  });

  it("refuses the key for a different adjustment, or the same one at another branch", async () => {
    const first = plain(dto());
    const cases: [unknown, StockAdjustmentDto, { branchId: string; batchId: string }?][] = [
      [first, dto({ qty: 3 })],
      [first, dto({ reason: "Under the counter" })],
      [first, dto({ reason: undefined })],
      [first, dto({ kind: "lost" })],
      [first, dto({ batchId: "batch-2" })],
      [first, dto({ fromQuarantine: false })],
      [first, dto(), { branchId: "branch-2", batchId: "batch-1" }],
      // A key recorded before bodies were kept has nothing to match.
      [null, dto()],
    ];
    for (const [requestBody, body, moved] of cases) {
      const { service, prisma, inventory, recorded } = setup();
      recorded(requestBody, moved);
      await expect(service.postDirect(user, BRANCH, body, KEY)).rejects.toThrow(
        new BadRequestException("Idempotency-Key already used for a different stock adjustment"),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(inventory.adjustment).not.toHaveBeenCalled();
    }
  });

  it("replays when the key committed while this request waited on its lock", async () => {
    const { service, prisma, tx, inventory } = setup();
    tx.idempotencyRecord.findUnique.mockResolvedValueOnce({ resourceId: "ref-original" });
    prisma.idempotencyRecord.findUnique
      .mockResolvedValueOnce(null) // before the transaction: not yet committed
      .mockResolvedValueOnce({ resourceId: "ref-original", requestBody: plain(dto()) });
    prisma.stockLedger.findFirst.mockResolvedValue({ branchId: BRANCH, batchId: "batch-1" });
    await expect(service.postDirect(user, BRANCH, dto(), KEY)).resolves.toMatchObject({ referenceId: "ref-original" });
    expect(inventory.adjustment).not.toHaveBeenCalled();
    expect(tx.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("refuses a different body that committed under the key while this request waited", async () => {
    const { service, prisma, tx, inventory } = setup();
    tx.idempotencyRecord.findUnique.mockResolvedValueOnce({ resourceId: "ref-original" });
    prisma.idempotencyRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ resourceId: "ref-original", requestBody: plain(dto({ qty: 5 })) });
    prisma.stockLedger.findFirst.mockResolvedValue({ branchId: BRANCH, batchId: "batch-1" });
    await expect(service.postDirect(user, BRANCH, dto(), KEY)).rejects.toThrow(BadRequestException);
    expect(inventory.adjustment).not.toHaveBeenCalled();
  });

  it("replays when the key's unique row is what stopped this request", async () => {
    const { service, prisma, tx } = setup();
    tx.idempotencyRecord.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["tenant_id", "user_id", "scope", "idempotency_key"] },
      }),
    );
    prisma.idempotencyRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ resourceId: "ref-original", requestBody: plain(dto()) });
    prisma.stockLedger.findFirst.mockResolvedValue({ branchId: BRANCH, batchId: "batch-1" });
    await expect(service.postDirect(user, BRANCH, dto(), KEY)).resolves.toEqual({
      held: false,
      ok: true,
      referenceId: "ref-original",
      batchId: "batch-1",
    });
  });

  it("leaves the key unused when the write-off needs approval, so the same save can try again", async () => {
    const { service, prisma, tx, inventory, actor } = setup();
    actor.has.mockImplementation((permission: string) => permission !== "inventory.write_off");
    const body = dto({ kind: "lost", reason: "Missing" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const refusal = await service.postDirect(user, BRANCH, body, KEY).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({ code: "WRITE_OFF_APPROVAL_REQUIRED" });
    }
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(inventory.adjustment).not.toHaveBeenCalled();
    expect(tx.idempotencyRecord.create).not.toHaveBeenCalled();
  });

  it("refuses a key longer than 128 characters before anything else", async () => {
    const { service, prisma } = setup();
    await expect(service.postDirect(user, BRANCH, dto(), "k".repeat(129))).rejects.toThrow(BadRequestException);
    expect(prisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
