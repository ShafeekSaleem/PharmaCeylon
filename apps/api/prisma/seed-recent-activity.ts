/**
 * Tops the demo up with recent activity — the last N days through today, in every Operations
 * section — so the screens read like a pharmacy that traded this week, not on the day it was
 * seeded.
 *
 * Unlike the bulk seeds, everything here goes through the real services (checkout, receiving,
 * the supplier ledger, transfers, stocktakes, returns, adjustments) with the clock set to the
 * moment each event happens. Stock moves through `StockService`, documents get their real
 * numbers, held deliveries and write-offs carry the payloads their Accept buttons expect, and
 * every timestamp — including the database's own defaults — lands on the day it describes.
 *
 * Events form chains (order → delivery two days later → invoice → payment), and any step that
 * falls after now is simply not run, so the newest documents are naturally still in progress.
 *
 * Safe to run again: each document has a deterministic key (idempotency key, supplier reference,
 * title or note) and is skipped when it already exists. Sales are topped up to a daily target, so
 * days the main seed already filled get nothing extra. Run it once a day (or later the same day
 * to top up today's trading); a backdated document is only consistent when nothing after its
 * date existed yet, which is why each run plays its events strictly in time order.
 *
 * Usage (from apps/api, API not required):
 *   npm run seed:recent                 # last 10 days
 *   npm run seed:recent -- --days=14
 */
import "dotenv/config";
import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { PaymentMethod, Prisma } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { StockService } from "../src/inventory/stock/stock.service";
import { StockReadService } from "../src/inventory/stock/stock-read.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { AdjustmentService } from "../src/inventory/adjustment.service";
import { TaxService } from "../src/pricing/tax.service";
import { PermissionsService } from "../src/security/permissions.service";
import { AccessService, type ActorAccess } from "../src/security/access.service";
import { NotificationsService } from "../src/notifications/notifications.service";
import { PharmacistApprovalService } from "../src/sales/pharmacist-approval.service";
import { SalesService } from "../src/sales/sales.service";
import { PurchasingService } from "../src/purchasing/purchasing.service";
import { HeldDeliveryService } from "../src/purchasing/held-delivery.service";
import { SupplierLedgerService } from "../src/purchasing/ledger/supplier-ledger.service";
import { TransfersService } from "../src/transfers/transfers.service";
import { StocktakesService } from "../src/stocktakes/stocktakes.service";
import { ReturnsService } from "../src/returns/returns.service";
import type { RequestUser } from "../src/security/interfaces/authenticated-request.interface";

// ── Clock ───────────────────────────────────────────────────────────────────

const RealDate = Date;

/** Run `fn` with `new Date()` and `Date.now()` reading `when` (advancing a few ms per call). */
async function at<T>(when: Date, fn: () => Promise<T>): Promise<T> {
  let t = when.getTime();
  class ClockDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(t);
        t += 5;
      } else {
        super(...(args as [number]));
      }
    }
    static now() {
      return t;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = ClockDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
}

/** Local calendar day `offset` days from today, at hh:mm. */
function dayAt(offset: number, hour: number, minute = 0): Date {
  const d = new RealDate();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/**
 * When something left in progress "today" should have happened. Before the pharmacy opens the
 * planned hour hasn't come yet, so it is placed at yesterday's close instead — it still reads as
 * the current, waiting item.
 */
function pendingAt(hour: number, minute = 0): Date {
  const planned = dayAt(0, hour, minute);
  return planned <= new RealDate() ? planned : dayAt(-1, 18, minute);
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tag(d: Date): string {
  return ymd(d).slice(2).replace(/-/g, "");
}

/** Deterministic per seed string, so a rerun plans the same events. */
function rngFor(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)]!;
}

// ── Setup ───────────────────────────────────────────────────────────────────

const config = new ConfigService();
const prisma = new PrismaService(config);
const audit = new AuditService(prisma);
const stock = new StockService();
const stockRead = new StockReadService(prisma);
const permissions = new PermissionsService(prisma, config);
const access = new AccessService(prisma, permissions);
const notifications = new NotificationsService(prisma, permissions);
const sales = new SalesService(
  prisma,
  audit,
  new TaxService(config),
  new PharmacistApprovalService(prisma, audit, permissions),
  // The demo tenant is set up; the readiness gate is for brand-new pharmacies.
  { assertCanSell: async () => undefined } as never,
  stock,
);
const purchasing = new PurchasingService(prisma, audit, stock, stockRead);
const heldDeliveries = new HeldDeliveryService(prisma, purchasing, notifications, audit);
const ledger = new SupplierLedgerService(prisma, audit);
const transfers = new TransfersService(prisma, audit, stock);
const stocktakes = new StocktakesService(prisma, audit, stock);
const returns = new ReturnsService(prisma, audit, stock);
const inventory = new InventoryService(prisma, audit, stock, stockRead);
const adjustments = new AdjustmentService(prisma, inventory, notifications, audit);

type Actor = { id: string; user: RequestUser };
type Branch = { id: string; code: string; name: string };

let tenantId = "";
const actors = new Map<string, Actor>();
let branches: Branch[] = [];

async function actor(email: string): Promise<Actor> {
  const hit = actors.get(email);
  if (hit) return hit;
  const row = await prisma.appUser.findFirstOrThrow({
    where: { tenantId, email },
    include: { userBranchRoles: true },
  });
  const found: Actor = {
    id: row.id,
    user: {
      userId: row.id,
      tenantId,
      email: row.email,
      fullName: row.fullName,
      authMethod: "bearer",
      branchRoles: row.userBranchRoles.map((r) => ({ branchId: r.branchId, role: r.role, roleId: r.roleId })),
    },
  };
  actors.set(email, found);
  return found;
}

const accessFor = (who: Actor, branchId: string): Promise<ActorAccess> => access.resolve(who.user, branchId);

function branch(code: string): Branch {
  const b = branches.find((x) => x.code === code);
  if (!b) throw new Error(`No branch ${code}`);
  return b;
}

const managerOf: Record<string, string> = {
  MAIN: "manager@pharmaceylon.demo",
  BRANCH2: "manager@pharmaceylon.demo",
  NEGOMBO: "manager2@pharmaceylon.demo",
  GALLE: "manager2@pharmaceylon.demo",
};
const cashiersOf: Record<string, string[]> = {
  MAIN: ["cashier@pharmaceylon.demo", "cashier2@pharmaceylon.demo", "cashier3@pharmaceylon.demo"],
  BRANCH2: ["cashier4@pharmaceylon.demo", "cashier5@pharmaceylon.demo"],
  NEGOMBO: ["cashier@pharmaceylon.demo"],
  GALLE: ["cashier@pharmaceylon.demo"],
};
/** Sales a branch rings up on a weekday; weekends run at 80%. */
const dailySales: Record<string, number> = { MAIN: 34, BRANCH2: 20, NEGOMBO: 14, GALLE: 12 };

// ── Stock the script can use ────────────────────────────────────────────────

type Lot = {
  batchId: string;
  productId: string;
  name: string;
  available: number;
  sellingPrice: Prisma.Decimal;
  costPrice: Prisma.Decimal;
  expiry: Date;
};

/** Sellable, in-date, over-the-counter lots at a branch, freshest data from batch_stock. */
async function lotsAt(branchId: string, onDay: Date, minDays = 45): Promise<Lot[]> {
  const horizon = new RealDate(onDay.getTime() + minDays * 86_400_000);
  const rows = await prisma.batchStock.findMany({
    where: {
      tenantId,
      branchId,
      onHandQty: { gt: 0 },
      batch: {
        expiryDate: { gt: horizon },
        needsExpiryReview: false,
        product: { rangeStatus: "RANGED", isActive: true, isControlled: false, requiresPrescription: false },
      },
    },
    include: { batch: { include: { product: { select: { name: true } } } } },
    take: 600,
  });
  return rows
    .map((r) => ({
      batchId: r.batchId,
      productId: r.productId,
      name: r.batch.product.name,
      available: r.onHandQty - r.quarantinedQty - r.reservedQty,
      sellingPrice: r.batch.sellingPrice,
      costPrice: r.batch.costPrice,
      expiry: r.batch.expiryDate,
    }))
    .filter((l) => l.available > 0 && Number(l.sellingPrice) > 0);
}

// ── Events ──────────────────────────────────────────────────────────────────

type Event = { at: Date; label: string; run: () => Promise<unknown> };
const events: Event[] = [];
const stats = new Map<string, { ok: number; skipped: number; failed: number }>();

function count(section: string, outcome: "ok" | "skipped" | "failed") {
  const s = stats.get(section) ?? { ok: 0, skipped: 0, failed: 0 };
  s[outcome] += 1;
  stats.set(section, s);
}

function schedule(when: Date, label: string, run: () => Promise<unknown>) {
  events.push({ at: when, label, run });
}

const now = new RealDate();

// ── Sales ───────────────────────────────────────────────────────────────────

async function planSales(offset: number) {
  const day = dayAt(offset, 0);
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  for (const b of branches) {
    const rng = rngFor(`sales-${ymd(day)}-${b.code}`);
    let target = Math.round((dailySales[b.code] ?? 10) * (weekend ? 0.8 : 1) * (0.9 + rng() * 0.2));
    // Today only trades up to now.
    if (offset === 0) {
      const share = Math.max(0, Math.min(1, (now.getHours() + now.getMinutes() / 60 - 8) / 13));
      target = Math.round(target * share);
    }
    const existing = await prisma.sale.count({
      where: { tenantId, branchId: b.id, soldAt: { gte: dayAt(offset, 0), lt: dayAt(offset + 1, 0) } },
    });
    const toAdd = Math.max(0, target - existing);
    if (toAdd === 0) continue;
    const times = Array.from({ length: toAdd }, () => 8 * 60 + Math.floor(rng() * 13 * 60))
      .sort((a, z) => a - z)
      .map((m) => dayAt(offset, Math.floor(m / 60), m % 60))
      .filter((t) => t < now);
    const customers = await prisma.customer.findMany({ where: { tenantId }, select: { id: true }, take: 40 });
    times.forEach((when, i) => {
      const key = `demo-sale-${ymd(day)}-${b.code}-${existing}-${i}`;
      schedule(when, `sale ${b.code}`, async () => {
        const lots = await lotsAt(b.id, when);
        if (lots.length === 0) return count("Sales", "skipped");
        const lineCount = 1 + Math.floor(rng() * 3);
        const used = new Set<string>();
        const items: Array<{ productId: string; batchId: string; qty: number; unitPrice: string; taxAmount: string }> = [];
        for (let l = 0; l < lineCount; l++) {
          const lot = pick(rng, lots);
          if (used.has(lot.productId)) continue;
          used.add(lot.productId);
          const qty = Math.min(lot.available, 1 + Math.floor(rng() * 3));
          items.push({ productId: lot.productId, batchId: lot.batchId, qty, unitPrice: lot.sellingPrice.toFixed(2), taxAmount: "0" });
        }
        const total = items.reduce((s, it) => s + Number(it.unitPrice) * it.qty, 0);
        const roll = rng();
        let payments: Array<{ method: PaymentMethod; amount: string; reference?: string }>;
        if (roll < 0.45) {
          // Cash, often handed over as a round note with change given.
          const tendered = rng() < 0.6 ? Math.ceil(total / 100) * 100 : total;
          payments = [{ method: PaymentMethod.cash, amount: tendered.toFixed(2) }];
        } else if (roll < 0.8) {
          payments = [{ method: PaymentMethod.card, amount: total.toFixed(2), reference: `AUTH${Math.floor(rng() * 1e6)}` }];
        } else if (roll < 0.9) {
          payments = [{ method: PaymentMethod.mobile_wallet, amount: total.toFixed(2), reference: `WAL${Math.floor(rng() * 1e6)}` }];
        } else {
          const cash = Math.min(total, Math.round(total * 0.4));
          payments = [
            { method: PaymentMethod.cash, amount: cash.toFixed(2) },
            { method: PaymentMethod.card, amount: (total - cash).toFixed(2), reference: `AUTH${Math.floor(rng() * 1e6)}` },
          ];
        }
        const seller = await actor(pick(rng, cashiersOf[b.code] ?? cashiersOf.MAIN!));
        const customerId = customers.length && rng() < 0.2 ? pick(rng, customers).id : undefined;
        await sales.checkout(
          tenantId,
          b.id,
          seller.id,
          seller.user.branchRoles,
          { items, payments, ...(customerId ? { customerId } : {}) } as never,
          key,
        );
        count("Sales", "ok");
      });
    });
  }
}

// ── Refunds ─────────────────────────────────────────────────────────────────

const REASONS = ["wrong_item", "changed_mind", "damaged", "expired", "adverse_reaction"] as const;

function planRefunds(offset: number) {
  const day = dayAt(offset, 0);
  const rng = rngFor(`refunds-${ymd(day)}`);
  const plan = [
    { code: pick(rng, ["MAIN", "BRANCH2"]), hour: 13 },
    { code: pick(rng, ["MAIN", "NEGOMBO", "GALLE"]), hour: 18 },
  ];
  for (const p of plan) {
    const when = dayAt(offset, p.hour, Math.floor(rng() * 50));
    if (when > now) continue;
    schedule(when, `refund ${p.code}`, async () => {
      const b = branch(p.code);
      // The clock is deterministic, so this refund is recognised by the minute it was given.
      const done = await prisma.goodsReturn.findFirst({
        where: { tenantId, branchId: b.id, type: "customer", createdAt: { gte: when, lt: new RealDate(when.getTime() + 60_000) } },
      });
      if (done) return count("Refunds", "skipped");
      const sale = await prisma.sale.findFirst({
        where: {
          tenantId,
          branchId: b.id,
          status: "posted",
          soldAt: { gte: dayAt(offset - 2, 0), lt: when },
          items: { every: { product: { isControlled: false, requiresPrescription: false } } },
        },
        include: { items: true },
        orderBy: { soldAt: "desc" },
        skip: Math.floor(rng() * 5),
      });
      if (!sale || sale.items.length === 0) return count("Refunds", "skipped");
      const line = sale.items[0]!;
      const reasonCode = pick(rng, REASONS);
      const cashier = await actor(pick(rng, cashiersOf[b.code] ?? cashiersOf.MAIN!));
      await sales.refundSale(tenantId, b.id, cashier.id, await accessFor(cashier, b.id), sale.id, {
        reasonCode,
        items: [
          {
            productId: line.productId,
            batchId: line.batchId!,
            qty: 1,
            disposition: reasonCode === "damaged" || reasonCode === "expired" || reasonCode === "adverse_reaction" ? "quarantine" : "restock",
          },
        ],
      } as never);
      count("Refunds", "ok");
    });
  }
}

// ── Purchasing: order → delivery → invoice → payment ───────────────────────

type PoChain = { branch: Branch; offset: number; ref: string; rng: () => number; leave?: "draft" | "pending" | "held" };

function planPurchasing(days: number) {
  const chains: PoChain[] = [];
  for (let offset = -days + 1; offset <= 0; offset++) {
    branches.forEach((b, idx) => {
      if ((offset + idx + 300) % 3 !== 0) return;
      const day = dayAt(offset, 0);
      chains.push({ branch: b, offset, ref: `RQ-${tag(day)}-${b.code}`, rng: rngFor(`po-${ymd(day)}-${b.code}`) });
    });
  }
  // Today's front of the pipeline: one order still a draft, one waiting for approval.
  chains.push({ branch: branch("MAIN"), offset: 0, ref: `RQ-${tag(dayAt(0, 0))}-MAIN-D`, rng: rngFor("po-draft"), leave: "draft" });
  chains.push({ branch: branch("BRANCH2"), offset: 0, ref: `RQ-${tag(dayAt(0, 0))}-BRANCH2-A`, rng: rngFor("po-pending"), leave: "pending" });
  // And a delivery that arrived over what was ordered, waiting for a manager.
  chains.push({ branch: branch("GALLE"), offset: -3, ref: `RQ-${tag(dayAt(-3, 0))}-GALLE-H`, rng: rngFor("po-held"), leave: "held" });

  for (const chain of chains) {
    const { branch: b, offset, ref, rng } = chain;
    const created =
      chain.leave === "draft" || chain.leave === "pending"
        ? pendingAt(9, 10 + Math.floor(rng() * 40))
        : dayAt(offset, 9, 10 + Math.floor(rng() * 40));
    if (created > now) continue;
    schedule(created, `PO ${ref}`, async () => {
      const exists = await prisma.purchaseOrder.findFirst({ where: { tenantId, supplierReference: ref } });
      if (exists) return count("Purchase orders", "skipped");
      const manager = await actor(managerOf[b.code]!);
      // A supplier with a price list, and the products of theirs this branch is lowest on.
      const suppliers = await prisma.supplier.findMany({
        where: { tenantId, isActive: true, status: "active", productPrices: { some: {} } },
        select: { id: true },
        orderBy: { code: "asc" },
      });
      if (suppliers.length === 0) return count("Purchase orders", "skipped");
      const supplier = pick(rng, suppliers);
      const prices = await prisma.supplierProductPrice.findMany({
        where: { tenantId, supplierId: supplier.id, product: { rangeStatus: "RANGED", isActive: true } },
        include: { product: { select: { id: true, unitsPerPack: true } } },
        take: 200,
      });
      if (prices.length === 0) return count("Purchase orders", "skipped");
      const onHand = await prisma.batchStock.groupBy({
        by: ["productId"],
        where: { tenantId, branchId: b.id, productId: { in: prices.map((p) => p.productId) } },
        _sum: { onHandQty: true },
      });
      const have = new Map(onHand.map((r) => [r.productId, r._sum.onHandQty ?? 0]));
      const chosen = [...prices]
        .sort((x, y) => (have.get(x.productId) ?? 0) - (have.get(y.productId) ?? 0) || rng() - 0.5)
        .slice(0, 4 + Math.floor(rng() * 4));
      const po = (await purchasing.createPurchaseOrder(tenantId, b.id, manager.id, {
        supplierId: supplier.id,
        supplierReference: ref,
        expectedOn: ymd(dayAt(offset + 2, 0)),
        submitForApproval: chain.leave === "pending",
        notes: chain.leave === "pending" ? "Weekly top-up — larger than usual for the season" : "Weekly top-up",
        items: chosen.map((p) => {
          const per = Math.max(1, p.unitsPerPack || p.product.unitsPerPack || 1);
          return per > 1
            ? { productId: p.productId, orderedPacks: 2 + Math.floor(rng() * 8), unitsPerPack: per, unitCost: p.unitCost.toFixed(4) }
            : { productId: p.productId, orderedQty: 12 + Math.floor(rng() * 60), unitCost: p.unitCost.toFixed(4) };
        }),
      } as never)) as { id: string; status: string };
      count("Purchase orders", "ok");
      if (chain.leave === "draft" || chain.leave === "pending" || po.status !== "draft") return;
      await purchasing.issuePurchaseOrder(tenantId, b.id, manager.id, po.id);

      // Delivery, two days on.
      const deliveredAt = dayAt(offset + 2, 10 + Math.floor(rng() * 5), Math.floor(rng() * 60));
      if (deliveredAt > now) return;
      schedule(deliveredAt, `delivery ${ref}`, () => deliver(chain, po.id, deliveredAt));
    });
  }
}

async function deliver(chain: PoChain, poId: string, when: Date) {
  const { branch: b, rng, ref } = chain;
  const clerk = await actor("clerk@pharmaceylon.demo");
  const po = await prisma.purchaseOrder.findFirstOrThrow({
    where: { id: poId, tenantId },
    include: { items: { include: { product: { select: { id: true } } } }, supplier: { select: { code: true } } },
  });
  if (po.status === "received") return count("Deliveries", "skipped");
  const short = rng() < 0.2;
  const lines = await Promise.all(
    po.items.map(async (item, i) => {
      const last = await prisma.batch.findFirst({
        where: { tenantId, productId: item.productId, sellingPrice: { gt: 0 } },
        orderBy: { receivedAt: "desc" },
        select: { sellingPrice: true },
      });
      const cost = Number(item.unitCost);
      const selling = last ? Number(last.sellingPrice) : Math.ceil(cost * 1.3);
      const outstanding = item.orderedQty - item.receivedQty;
      const qty = chain.leave === "held" && i === 0 ? outstanding + Math.max(6, Math.ceil(outstanding * 0.5)) : short && i === 0 ? Math.max(1, Math.floor(outstanding / 2)) : outstanding;
      return {
        productId: item.productId,
        batchNo: `${po.supplier.code.replace(/[^A-Z0-9]/gi, "")}${tag(when)}${i}`,
        expiryDate: ymd(dayAt(300 + Math.floor(rng() * 500), 0)),
        receivedQty: qty,
        freeQty: rng() < 0.12 ? 2 : 0,
        rejectedQty: rng() < 0.1 ? 1 : 0,
        rejectedReason: "Crushed in transit",
        costPrice: cost.toFixed(4),
        sellingPrice: selling.toFixed(2),
      };
    }),
  );
  const delivery = {
    purchaseOrderId: po.id,
    receivedOn: ymd(when),
    supplierDeliveryNote: `DN-${tag(when)}-${b.code}`,
    lines: lines.map((l) => (l.rejectedQty ? l : { ...l, rejectedReason: undefined })),
  };
  if (chain.leave === "held") {
    const pending = await prisma.heldDelivery.findFirst({ where: { tenantId, purchaseOrderId: po.id } });
    if (pending) return count("Held deliveries", "skipped");
    await heldDeliveries.hold(tenantId, b.id, clerk.id, po.id, {
      reasons: ["over_delivery"],
      detail: `${lines[0]!.receivedQty} arrived against ${po.items[0]!.orderedQty} ordered — the supplier sent a full carton.`,
      delivery,
    } as never);
    return count("Held deliveries", "ok");
  }
  const receipt = (await purchasing.receiveGoods(
    tenantId,
    b.id,
    clerk.id,
    await accessFor(clerk, b.id),
    delivery as never,
    `demo-receive-${ref}`,
  )) as { id?: string; goodsReceipt?: { id: string } };
  count("Deliveries", "ok");
  const grn = await prisma.goodsReceipt.findFirst({ where: { tenantId, purchaseOrderId: po.id }, orderBy: { createdAt: "desc" } });
  if (!grn) return;

  // The supplier's invoice a day later, for most deliveries.
  if (rng() < 0.75) {
    const invoicedAt = dayAt(chain.offset + 3, 15, Math.floor(rng() * 50));
    if (invoicedAt <= now) schedule(invoicedAt, `invoice ${ref}`, () => invoice(chain, grn.id, invoicedAt));
  }
  void receipt;
}

async function invoice(chain: PoChain, grnId: string, when: Date) {
  const { branch: b, rng, ref } = chain;
  const manager = await actor(managerOf[b.code]!);
  const grn = await prisma.goodsReceipt.findFirstOrThrow({
    where: { id: grnId, tenantId },
    include: { items: true, purchaseOrder: { select: { supplierId: true, supplier: { select: { code: true } } } } },
  });
  const number = `${grn.purchaseOrder.supplier.code.replace(/[^A-Z0-9]/gi, "")}-${tag(when)}-${b.code.slice(0, 3)}`;
  const exists = await prisma.supplierInvoice.findFirst({
    where: { tenantId, supplierId: grn.purchaseOrder.supplierId, invoiceNumber: number },
  });
  let invoiceId = exists?.id;
  if (!exists) {
    const created = (await ledger.createInvoice(tenantId, b.id, manager.id, {
      supplierId: grn.purchaseOrder.supplierId,
      invoiceNumber: number,
      invoiceDate: ymd(dayAt(chain.offset + 2, 0)),
      receiptIds: [grn.id],
      lines: grn.items.map((it) => ({
        productId: it.productId,
        qty: it.receivedQty + it.rejectedQty,
        unitCost: (it.unitCost ?? new Prisma.Decimal(0)).toFixed(4),
      })),
    } as never)) as { id: string };
    invoiceId = created.id;
    count("Supplier invoices", "ok");
  } else {
    count("Supplier invoices", "skipped");
  }
  // Paid a few days later, sometimes in part.
  if (invoiceId && rng() < 0.7) {
    const paidAt = dayAt(chain.offset + 6, 11, Math.floor(rng() * 50));
    if (paidAt <= now) schedule(paidAt, `payment ${ref}`, () => pay(chain, invoiceId!, paidAt));
  }
}

async function pay(chain: PoChain, invoiceId: string, when: Date) {
  const { branch: b, rng, ref } = chain;
  const manager = await actor(managerOf[b.code]!);
  const inv = await prisma.supplierInvoice.findFirstOrThrow({ where: { id: invoiceId, tenantId } });
  const balance = Number(inv.totalAmount) - Number(inv.paidAmount);
  if (balance <= 0) return count("Supplier payments", "skipped");
  const amount = rng() < 0.3 ? Math.round(balance * 0.5) : balance;
  await ledger.recordPayment(
    tenantId,
    b.id,
    manager.id,
    {
      supplierId: inv.supplierId,
      paidOn: ymd(when),
      amount: amount.toFixed(2),
      method: rng() < 0.7 ? "bank_transfer" : "cheque",
      reference: `TRF${tag(when)}${Math.floor(rng() * 1000)}`,
      allocations: [{ invoiceId, amount: amount.toFixed(2) }],
    } as never,
    `demo-pay-${ref}`,
  );
  count("Supplier payments", "ok");
}

// ── Transfers ───────────────────────────────────────────────────────────────

function planTransfers(days: number) {
  const routes: Array<[string, string]> = [
    ["MAIN", "BRANCH2"],
    ["MAIN", "NEGOMBO"],
    ["MAIN", "GALLE"],
    ["BRANCH2", "MAIN"],
  ];
  let n = 0;
  for (let offset = -days + 1; offset <= 0; offset++) {
    // Every other day, plus yesterday's (still on the road) and today's (waiting for approval).
    if ((offset + 100) % 2 !== 0 && offset !== 0 && offset !== -1) continue;
    const [fromCode, toCode] = routes[n++ % routes.length]!;
    const day = dayAt(offset, 0);
    const rng = rngFor(`transfer-${ymd(day)}`);
    const note = `Restock run ${tag(day)} ${fromCode}→${toCode}`;
    // Today's request waits for approval; the rest move along.
    const waitForApproval = offset === 0;
    const created = waitForApproval ? pendingAt(10, Math.floor(rng() * 40)) : dayAt(offset, 10, Math.floor(rng() * 40));
    if (created > now) continue;
    schedule(created, `transfer ${note}`, async () => {
      const from = branch(fromCode);
      const to = branch(toCode);
      if (await prisma.transfer.findFirst({ where: { tenantId, notes: note } })) return count("Transfers", "skipped");
      const requester = await actor(waitForApproval ? "clerk@pharmaceylon.demo" : managerOf[fromCode]!);
      const lots = (await lotsAt(from.id, created, 90)).filter((l) => l.available >= 20);
      if (lots.length < 3) return count("Transfers", "skipped");
      const chosen = new Map<string, Lot>();
      while (chosen.size < 3 + Math.floor(rng() * 3) && chosen.size < lots.length) {
        const lot = pick(rng, lots);
        if (!chosen.has(lot.productId)) chosen.set(lot.productId, lot);
      }
      const created_ = (await transfers.create(tenantId, from.id, await accessFor(requester, from.id), {
        toBranchId: to.id,
        expectedOn: ymd(dayAt(offset + 1, 0)),
        notes: note,
        items: [...chosen.values()].map((l) => ({ productId: l.productId, batchId: l.batchId, qty: 4 + Math.floor(rng() * Math.min(16, l.available / 2)) })),
      } as never)) as { id: string; status: string };
      count("Transfers", "ok");
      if (waitForApproval) return;
      const manager = await actor(managerOf[fromCode]!);
      if (created_.status === "requested") await transfers.approve(tenantId, from.id, await accessFor(manager, from.id), created_.id);
      const shipped = dayAt(offset, 15, Math.floor(rng() * 50));
      if (shipped > now) return;
      schedule(shipped, `ship ${note}`, async () => {
        await transfers.ship(tenantId, from.id, manager.id, created_.id, `demo-ship-${tag(day)}-${fromCode}`);
        // Yesterday's is still on the road.
        const received = dayAt(offset + 1, 11, Math.floor(rng() * 50));
        if (received > now || offset === -1) return;
        schedule(received, `receive ${note}`, async () => {
          const receiver = await actor(managerOf[toCode]!);
          await transfers.receive(tenantId, to.id, receiver.id, created_.id, {}, `demo-recv-${tag(day)}-${toCode}`);
        });
      });
    });
  }
}

// ── Stocktakes ──────────────────────────────────────────────────────────────

const VARIANCE_REASONS = ["unrecorded_sale", "damaged_stock", "supplier_shortage", "wrong_batch_used"] as const;

function planStocktakes() {
  const plans = [
    { code: "MAIN", offset: -6, finish: "approved" as const, title: "Cycle count — cough & cold shelf" },
    { code: "NEGOMBO", offset: -1, finish: "submitted" as const, title: "Cycle count — vitamins aisle" },
    { code: "BRANCH2", offset: 0, finish: "counting" as const, title: "Cycle count — front counter" },
  ];
  for (const p of plans) {
    const created = p.offset === 0 ? pendingAt(8, 30) : dayAt(p.offset, 8, 30);
    if (created > now) continue;
    const title = `${p.title} (${tag(dayAt(p.offset, 0))})`;
    const rng = rngFor(title);
    schedule(created, `stocktake ${title}`, async () => {
      const b = branch(p.code);
      const manager = await actor(managerOf[p.code]!);
      const clerk = await actor("clerk@pharmaceylon.demo");
      const managerAccess = await accessFor(manager, b.id);
      const existing = await prisma.stocktake.findFirst({ where: { tenantId, title } });
      if (existing) {
        // A review that stopped part-way is picked up again.
        if (p.finish === "approved" && existing.status !== "approved" && existing.status !== "completed") {
          schedule(dayAt(p.offset + 1, 10, 15), `review ${title}`, () => review(existing.id, b, manager, managerAccess, rng));
        }
        return count("Stocktakes", "skipped");
      }
      // A snapshot copies each batch's count as it is now. Backdated, that is only true of a batch
      // nothing has moved since — otherwise later movements would be counted twice at review.
      const candidates = await lotsAt(b.id, created, 30);
      const moved = await prisma.stockLedger.groupBy({
        by: ["batchId"],
        where: { tenantId, batchId: { in: candidates.map((l) => l.batchId) }, occurredAt: { gt: created } },
      });
      const movedSince = new Set(moved.map((m) => m.batchId));
      const lots = candidates.filter((l) => !movedSince.has(l.batchId));
      if (lots.length < 4) return count("Stocktakes", "skipped");
      const batchIds = [...new Set(Array.from({ length: 10 }, () => pick(rng, lots).batchId))];
      const st = (await stocktakes.create(
        tenantId,
        b.id,
        manager.id,
        { title, scope: "custom", batchIds, counterIds: [clerk.id], reviewerId: manager.id, areaLabel: "Shelf A" } as never,
        managerAccess,
      )) as { id: string };
      await stocktakes.start(tenantId, b.id, manager.id, st.id, managerAccess);
      count("Stocktakes", "ok");
      const lines = await prisma.stocktakeLine.findMany({ where: { tenantId, stocktakeId: st.id } });
      const countedAt = p.offset === 0 ? new RealDate(created.getTime() + 40 * 60_000) : dayAt(p.offset, 11, Math.floor(rng() * 40));
      if (countedAt > now) return;
      schedule(countedAt, `count ${title}`, async () => {
        const clerkAccess = await accessFor(clerk, b.id);
        const toCount = p.finish === "counting" ? lines.slice(0, Math.ceil(lines.length / 2)) : lines;
        await stocktakes.upsertLines(
          tenantId,
          b.id,
          clerk.id,
          st.id,
          {
            lines: toCount.map((line, i) => ({
              batchId: line.batchId,
              countedQty: i === 1 ? Math.max(0, line.systemQty - 2) : i === 3 ? line.systemQty + 1 : line.systemQty,
              condition: i === 4 ? "damaged" : "saleable",
            })),
          } as never,
          clerkAccess,
        );
        if (p.finish === "counting") return;
        await stocktakes.submit(tenantId, b.id, clerk.id, st.id, clerkAccess);
        if (p.finish !== "approved") return;
        schedule(dayAt(p.offset + 1, 10, 15), `review ${title}`, () => review(st.id, b, manager, managerAccess, rng));
      });
    });
  }
}

/** Review as the manager: a reason on every line whose count differs from what was expected. */
async function review(id: string, b: Branch, manager: Actor, managerAccess: ActorAccess, rng: () => number) {
  const row = await prisma.stocktake.findFirstOrThrow({ where: { id, tenantId } });
  if (row.status === "submitted") await stocktakes.startReview(tenantId, b.id, manager.id, id, managerAccess);
  const detail = (await stocktakes.getOne(tenantId, b.id, id, managerAccess)) as {
    lines: Array<{ id: string; adjustedVariance: number | null; reviewReason: string | null }>;
  };
  const differing = detail.lines.filter((l) => l.adjustedVariance && !l.reviewReason);
  if (differing.length) {
    await stocktakes.reviewLines(
      tenantId,
      b.id,
      manager.id,
      id,
      { lines: differing.map((l) => ({ lineId: l.id, reviewReason: pick(rng, VARIANCE_REASONS) })) } as never,
      managerAccess,
    );
  }
  await stocktakes.approve(tenantId, b.id, manager.id, id, managerAccess);
  count("Stocktake reviews", "ok");
}

// ── Adjustments ─────────────────────────────────────────────────────────────

function planAdjustments(days: number) {
  const kinds = ["damaged", "lost", "found", "damaged", "expired"] as const;
  for (let offset = -days + 1; offset <= 0; offset++) {
    const day = dayAt(offset, 0);
    const rng = rngFor(`adjust-${ymd(day)}`);
    const code = branches[(offset + 100) % branches.length]!.code;
    const kind = kinds[(offset + 100) % kinds.length]!;
    // Today's is a clerk's write-off, waiting for someone who may write off stock.
    const held = offset === 0;
    const when = held ? pendingAt(9, Math.floor(rng() * 50)) : dayAt(offset, 17, Math.floor(rng() * 50));
    if (when > now) continue;
    const note = `Shelf check ${tag(day)}`;
    schedule(when, `adjust ${code}`, async () => {
      const b = branch(held ? "MAIN" : code);
      const already = held
        ? await prisma.heldAdjustment.findFirst({ where: { tenantId, note } })
        : await prisma.stockLedger.findFirst({ where: { tenantId, reason: { contains: note } } });
      if (already) return count("Adjustments", "skipped");
      const who = await actor(held ? "clerk@pharmaceylon.demo" : managerOf[b.code]!);
      const lots = await lotsAt(b.id, when, kind === "expired" ? 0 : 45);
      if (lots.length === 0) return count("Adjustments", "skipped");
      const lot = pick(rng, lots);
      await adjustments.adjust(tenantId, b.id, await accessFor(who, b.id), {
        kind: held ? "damaged" : kind,
        productId: lot.productId,
        batchId: lot.batchId,
        qty: held ? 2 : 1 + Math.floor(rng() * 2),
        reason: note,
      } as never);
      count("Adjustments", "ok");
    });
  }
}

// ── Supplier returns ────────────────────────────────────────────────────────

function planSupplierReturns() {
  const plans = [
    { code: "MAIN", offset: -3, complete: true, reason: "Damaged on arrival — crushed cartons" },
    { code: "BRANCH2", offset: 0, complete: false, reason: "Short-dated stock to send back" },
  ];
  for (const p of plans) {
    const when = p.offset === 0 ? pendingAt(16, 20) : dayAt(p.offset, 16, 20);
    if (when > now) continue;
    const marker = `Demo return ${tag(dayAt(p.offset, 0))}`;
    schedule(when, `supplier return ${p.code}`, async () => {
      const b = branch(p.code);
      if (await prisma.goodsReturn.findFirst({ where: { tenantId, notes: marker } })) return count("Supplier returns", "skipped");
      const manager = await actor(managerOf[p.code]!);
      const grn = await prisma.goodsReceipt.findFirst({
        where: { tenantId, branchId: b.id, receivedOn: { lt: when } },
        orderBy: { receivedOn: "desc" },
        include: { items: true, purchaseOrder: { select: { id: true, supplierId: true } } },
      });
      const item = grn?.items.find((i) => i.receivedQty >= 4);
      if (!grn || !item) return count("Supplier returns", "skipped");
      const managerAccess = await accessFor(manager, b.id);
      const created = (await returns.create(tenantId, b.id, managerAccess, {
        type: "supplier",
        supplierId: grn.purchaseOrder.supplierId,
        purchaseOrderId: grn.purchaseOrder.id,
        goodsReceiptId: grn.id,
        reason: p.reason,
        notes: marker,
        submit: p.complete,
        items: [{ productId: item.productId, batchId: item.batchId, qty: 2, unitPrice: Number(item.unitCost ?? 0) }],
      } as never)) as { id: string };
      if (p.complete) await returns.complete(tenantId, b.id, manager.id, created.id, `demo-return-${tag(when)}`);
      count("Supplier returns", "ok");
    });
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = Math.max(1, Math.min(30, Number(daysArg?.split("=")[1] ?? 10) || 10));
  const tenantCode = process.argv.find((a) => a.startsWith("--tenant="))?.split("=")[1] ?? "demo";

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { code: tenantCode } });
  tenantId = tenant.id;
  branches = await prisma.branch.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  console.log(`Recent activity for ${tenant.displayName}: the last ${days} days through ${ymd(now)}`);

  for (let offset = -days + 1; offset <= 0; offset++) {
    await planSales(offset);
    planRefunds(offset);
  }
  planPurchasing(days);
  planTransfers(days);
  planStocktakes();
  planAdjustments(days);
  planSupplierReturns();

  // Events schedule follow-ups as they run, so keep draining in time order.
  let done = 0;
  while (events.length > 0) {
    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    const next = events.shift()!;
    try {
      await at(next.at, next.run);
    } catch (err) {
      const section = next.label.split(" ")[0]!;
      count(`failed: ${section}`, "failed");
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  ✗ ${ymd(next.at)} ${next.label}: ${message.slice(0, 160)}`);
    }
    if (++done % 100 === 0) console.log(`  … ${done} events`);
  }

  console.log("\nDone:");
  for (const [section, s] of [...stats.entries()].sort()) {
    console.log(`  ${section.padEnd(20)} ${s.ok} added${s.skipped ? `, ${s.skipped} already there` : ""}${s.failed ? `, ${s.failed} failed` : ""}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
