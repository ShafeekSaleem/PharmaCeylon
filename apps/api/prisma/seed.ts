import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PoPriority,
  PoStatus,
  Prisma,
  PrismaClient,
  RoleName,
  SaleStatus,
  StockMovementType,
  TransferStatus,
  GoodsReturnStatus,
  GoodsReturnType,
  StocktakeStatus,
  StocktakeScope,
  SupplierInvoiceStatus,
  SupplierStatus,
  SupplierType,
} from "@prisma/client";
import * as bcrypt from "bcrypt";
import {
  dateOnly,
  daysAgo,
  daysFromNow,
  dec,
  seedReceiveStock,
  seedSale,
} from "./seed-helpers";
import { seedDemoOps } from "./seed-demo-ops";
import { DEMO_STOCK_REG_NOS, seedNmraCatalog } from "./seed-nmra";
import { ensureRbacSeed } from "./rbac-seed";
import { seedRetailDemoProducts } from "./seed-retail-demo-products";
import { seedRetailDemoSales } from "./seed-retail-demo-sales";
import {
  demoPricingForProduct,
  demoStockLineForIndex,
} from "../src/nmra/nmra-normalize";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error(
    "DATABASE_URL is not set. Create apps/api/.env from .env.example or export DATABASE_URL before seeding.",
  );
}

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });

const TENANT_CODE = "demo";

async function clearOperationalData(tenantId: string) {
  await prisma.idempotencyRecord.deleteMany({ where: { tenantId } });
  await prisma.heldSale.deleteMany({ where: { tenantId } });
  await prisma.branchMonthlyTarget.deleteMany({ where: { tenantId } });
  await prisma.goodsReturn.deleteMany({ where: { tenantId } });
  await prisma.sale.deleteMany({ where: { tenantId } });
  await prisma.supplierInvoice.deleteMany({ where: { tenantId } });
  await prisma.goodsReceipt.deleteMany({ where: { tenantId } });
  await prisma.stocktake.deleteMany({ where: { tenantId } });
  await prisma.stockLedger.deleteMany({ where: { tenantId } });
  await prisma.transfer.deleteMany({ where: { tenantId } });
  await prisma.batch.deleteMany({ where: { tenantId } });
  await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
  await prisma.documentSequence.deleteMany({ where: { tenantId } });
  await prisma.auditEvent.deleteMany({ where: { tenantId } });
  await prisma.productAlias.deleteMany({ where: { tenantId } });
  await prisma.productTagMap.deleteMany({ where: { tenantId } });
  await prisma.productCategoryMap.deleteMany({ where: { tenantId } });
  await prisma.productSimilarity.deleteMany({ where: { tenantId } });
}

/**
 * Demo stock / ops scenarios still use stable PCL-* keys.
 * Those resolve to real NMRA registration numbers via seed-nmra DEMO_STOCK_REG_NOS.
 */

/** MAIN branch on-hand targets after seed stock (before sales). */
const MAIN_STOCK: Array<{ sku: string; qty: number; cost: number; sell: number }> = [
  { sku: "PCL-0001", qty: 180, cost: 42, sell: 55 },
  { sku: "PCL-0002", qty: 95, cost: 120, sell: 165 },
  { sku: "PCL-0003", qty: 110, cost: 18, sell: 28 },
  { sku: "PCL-0004", qty: 75, cost: 55, sell: 72 },
  { sku: "PCL-0005", qty: 8, cost: 12, sell: 22 },
  { sku: "PCL-0006", qty: 45, cost: 88, sell: 115 },
  { sku: "PCL-0007", qty: 60, cost: 35, sell: 48 },
  { sku: "PCL-0008", qty: 88, cost: 22, sell: 32 },
  { sku: "PCL-0009", qty: 140, cost: 28, sell: 38 },
  { sku: "PCL-0010", qty: 40, cost: 210, sell: 285 },
  { sku: "PCL-0011", qty: 22, cost: 450, sell: 620 },
  { sku: "PCL-0012", qty: 55, cost: 32, sell: 45 },
  { sku: "PCL-0013", qty: 35, cost: 95, sell: 130 },
  { sku: "PCL-0014", qty: 28, cost: 75, sell: 98 },
  { sku: "PCL-0015", qty: 65, cost: 48, sell: 65 },
  { sku: "PCL-0016", qty: 42, cost: 65, sell: 85 },
  { sku: "PCL-0017", qty: 25, cost: 15, sell: 25 },
  { sku: "PCL-0018", qty: 38, cost: 8, sell: 15 },
  { sku: "PCL-0019", qty: 72, cost: 95, sell: 125 },
  { sku: "PCL-0020", qty: 48, cost: 12, sell: 20 },
  { sku: "PCL-0021", qty: 12, cost: 180, sell: 240 },
  { sku: "PCL-0022", qty: 10, cost: 25, sell: 38 },
  { sku: "PCL-0023", qty: 8, cost: 45, sell: 62 },
  { sku: "PCL-0024", qty: 30, cost: 85, sell: 115 },
  { sku: "PCL-0025", qty: 24, cost: 120, sell: 165 },
  { sku: "PCL-0026", qty: 15, cost: 1200, sell: 1580 },
  { sku: "PCL-0027", qty: 50, cost: 180, sell: 250 },
  { sku: "PCL-0028", qty: 40, cost: 95, sell: 135 },
  { sku: "PCL-0030", qty: 55, cost: 65, sell: 88 },
];

const BRANCH2_STOCK: Array<{ sku: string; qty: number; cost: number; sell: number }> = [
  { sku: "PCL-0001", qty: 45, cost: 42, sell: 55 },
  { sku: "PCL-0003", qty: 35, cost: 18, sell: 28 },
  { sku: "PCL-0005", qty: 5, cost: 12, sell: 22 },
  { sku: "PCL-0009", qty: 60, cost: 28, sell: 38 },
  { sku: "PCL-0027", qty: 20, cost: 180, sell: 250 },
];

async function main() {
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "Owner123!";
  const cashierPassword = process.env.SEED_CASHIER_PASSWORD ?? "Cashier123!";
  const managerPassword = process.env.SEED_MANAGER_PASSWORD ?? "Manager123!";
  const pharmacistPassword = process.env.SEED_PHARMACIST_PASSWORD ?? "Pharmacist123!";
  const clerkPassword = process.env.SEED_CLERK_PASSWORD ?? "Clerk123!";

  for (const p of [
    ownerPassword,
    cashierPassword,
    managerPassword,
    pharmacistPassword,
    clerkPassword,
  ]) {
    if (p.length < 8) throw new Error("SEED_*_PASSWORD values must be at least 8 characters");
  }

  const tenant = await prisma.tenant.upsert({
    where: { code: TENANT_CODE },
    update: { displayName: "PharmaCeylon Demo Pharmacy", isActive: true },
    create: {
      code: TENANT_CODE,
      legalName: "Demo Pharmacy (Private) Limited",
      displayName: "PharmaCeylon Demo Pharmacy",
      complianceRegion: "LK",
      timezone: "Asia/Colombo",
    },
  });

  await clearOperationalData(tenant.id);

  const mainBranch = await prisma.branch.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "MAIN" } },
    update: { name: "Colombo — Main", isActive: true, timezone: "Asia/Colombo" },
    create: {
      tenantId: tenant.id,
      code: "MAIN",
      name: "Colombo — Main",
      timezone: "Asia/Colombo",
      city: "Colombo",
      addressLine1: "42 Galle Road",
      phone: "+94 11 234 5678",
    },
  });

  const secondBranch = await prisma.branch.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "BRANCH2" } },
    update: { name: "Kandy — Branch 2", isActive: true, timezone: "Asia/Colombo" },
    create: {
      tenantId: tenant.id,
      code: "BRANCH2",
      name: "Kandy — Branch 2",
      timezone: "Asia/Colombo",
      city: "Kandy",
      addressLine1: "18 Peradeniya Road",
      phone: "+94 81 222 3344",
    },
  });

  const galleBranch = await prisma.branch.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "GALLE" } },
    update: { name: "Galle — Fort", isActive: true, timezone: "Asia/Colombo" },
    create: {
      tenantId: tenant.id,
      code: "GALLE",
      name: "Galle — Fort",
      timezone: "Asia/Colombo",
      city: "Galle",
      addressLine1: "7 Church Street",
      phone: "+94 91 224 5566",
    },
  });

  const negomboBranch = await prisma.branch.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "NEGOMBO" } },
    update: { name: "Negombo — Beach Road", isActive: true, timezone: "Asia/Colombo" },
    create: {
      tenantId: tenant.id,
      code: "NEGOMBO",
      name: "Negombo — Beach Road",
      timezone: "Asia/Colombo",
      city: "Negombo",
      addressLine1: "112 Lewis Place",
      phone: "+94 31 222 7788",
    },
  });

  const allBranches = [mainBranch, secondBranch, galleBranch, negomboBranch];

  const [ownerHash, cashierHash, managerHash, pharmacistHash, clerkHash] = await Promise.all([
    bcrypt.hash(ownerPassword, 10),
    bcrypt.hash(cashierPassword, 10),
    bcrypt.hash(managerPassword, 10),
    bcrypt.hash(pharmacistPassword, 10),
    bcrypt.hash(clerkPassword, 10),
  ]);

  const owner = await prisma.appUser.upsert({
    where: { email: "owner@pharmaceylon.demo" },
    update: {
      tenantId: tenant.id,
      fullName: "Seed Owner",
      isActive: true,
      passwordHash: ownerHash,
    },
    create: {
      tenantId: tenant.id,
      email: "owner@pharmaceylon.demo",
      fullName: "Seed Owner",
      passwordHash: ownerHash,
    },
  });

  // Retire legacy admin@ login — there is no platform Admin role; owner covers governance.
  const legacyAdmin = await prisma.appUser.findUnique({
    where: { email: "admin@pharmaceylon.demo" },
    select: { id: true },
  });
  if (legacyAdmin) {
    await prisma.userBranchRole.deleteMany({ where: { userId: legacyAdmin.id } });
    await prisma.appUser.update({
      where: { id: legacyAdmin.id },
      data: { isActive: false, fullName: "Retired Seed Admin" },
    });
  }

  const manager = await prisma.appUser.upsert({
    where: { email: "manager@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Nimal Perera", isActive: true, passwordHash: managerHash },
    create: { tenantId: tenant.id, email: "manager@pharmaceylon.demo", fullName: "Nimal Perera", passwordHash: managerHash },
  });

  // Second manager — each of the two oversees a 2-branch pair instead of one manager covering all 4.
  const manager2 = await prisma.appUser.upsert({
    where: { email: "manager2@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Priyanka Jayasekara", isActive: true, passwordHash: managerHash },
    create: {
      tenantId: tenant.id,
      email: "manager2@pharmaceylon.demo",
      fullName: "Priyanka Jayasekara",
      passwordHash: managerHash,
    },
  });

  const pharmacistPosPinHash = await bcrypt.hash(
    process.env.SEED_PHARMACIST_POS_PIN ?? "1234",
    10,
  );
  const pharmacist = await prisma.appUser.upsert({
    where: { email: "pharmacist@pharmaceylon.demo" },
    update: {
      tenantId: tenant.id,
      fullName: "Dr. Anjali Fernando",
      isActive: true,
      passwordHash: pharmacistHash,
      posPinHash: pharmacistPosPinHash,
      failedPosPinAttempts: 0,
      posPinLockedUntil: null,
    },
    create: {
      tenantId: tenant.id,
      email: "pharmacist@pharmaceylon.demo",
      fullName: "Dr. Anjali Fernando",
      passwordHash: pharmacistHash,
      posPinHash: pharmacistPosPinHash,
    },
  });

  const cashier = await prisma.appUser.upsert({
    where: { email: "cashier@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Kamal Silva", isActive: true, passwordHash: cashierHash },
    create: { tenantId: tenant.id, email: "cashier@pharmaceylon.demo", fullName: "Kamal Silva", passwordHash: cashierHash },
  });

  // Extra branch-scoped cashiers so Staff Productivity has more than one name per branch.
  const mainCashierDefs = [
    { email: "cashier2@pharmaceylon.demo", fullName: "Sanduni Fernando" },
    { email: "cashier3@pharmaceylon.demo", fullName: "Dinesh Wickramasinghe" },
  ];
  const branch2CashierDefs = [
    { email: "cashier4@pharmaceylon.demo", fullName: "Ishara Perera" },
    { email: "cashier5@pharmaceylon.demo", fullName: "Chamara Silva" },
  ];
  const mainCashiers = await Promise.all(
    mainCashierDefs.map((d) =>
      prisma.appUser.upsert({
        where: { email: d.email },
        update: { tenantId: tenant.id, fullName: d.fullName, isActive: true, passwordHash: cashierHash },
        create: { tenantId: tenant.id, email: d.email, fullName: d.fullName, passwordHash: cashierHash },
      }),
    ),
  );
  const branch2Cashiers = await Promise.all(
    branch2CashierDefs.map((d) =>
      prisma.appUser.upsert({
        where: { email: d.email },
        update: { tenantId: tenant.id, fullName: d.fullName, isActive: true, passwordHash: cashierHash },
        create: { tenantId: tenant.id, email: d.email, fullName: d.fullName, passwordHash: cashierHash },
      }),
    ),
  );

  const inventoryClerk = await prisma.appUser.upsert({
    where: { email: "clerk@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Priya Jayawardena", isActive: true, passwordHash: clerkHash },
    create: { tenantId: tenant.id, email: "clerk@pharmaceylon.demo", fullName: "Priya Jayawardena", passwordHash: clerkHash },
  });

  const extraCashierIds = [...mainCashiers, ...branch2Cashiers].map((u) => u.id);

  await prisma.userBranchRole.deleteMany({
    where: {
      tenantId: tenant.id,
      userId: {
        in: [
          owner.id,
          manager.id,
          manager2.id,
          pharmacist.id,
          cashier.id,
          inventoryClerk.id,
          ...extraCashierIds,
        ],
      },
    },
  });

  // Manager 1 (Nimal) oversees MAIN + BRANCH2; Manager 2 (Priyanka) oversees GALLE + NEGOMBO.
  const manager1Branches = [mainBranch, secondBranch];
  const manager2Branches = [galleBranch, negomboBranch];
  const managerIdByBranch = new Map<string, string>([
    ...manager1Branches.map((b) => [b.id, manager.id] as const),
    ...manager2Branches.map((b) => [b.id, manager2.id] as const),
  ]);

  await prisma.userBranchRole.createMany({
    data: [
      ...allBranches.flatMap((branch) => [
        { tenantId: tenant.id, userId: owner.id, branchId: branch.id, role: RoleName.owner },
        { tenantId: tenant.id, userId: cashier.id, branchId: branch.id, role: RoleName.cashier },
        {
          tenantId: tenant.id,
          userId: inventoryClerk.id,
          branchId: branch.id,
          role: RoleName.inventory_clerk,
        },
      ]),
      ...manager1Branches.map((branch) => ({
        tenantId: tenant.id,
        userId: manager.id,
        branchId: branch.id,
        role: RoleName.manager,
      })),
      ...manager2Branches.map((branch) => ({
        tenantId: tenant.id,
        userId: manager2.id,
        branchId: branch.id,
        role: RoleName.manager,
      })),
      { tenantId: tenant.id, userId: pharmacist.id, branchId: mainBranch.id, role: RoleName.pharmacist },
      { tenantId: tenant.id, userId: pharmacist.id, branchId: secondBranch.id, role: RoleName.pharmacist },
      { tenantId: tenant.id, userId: pharmacist.id, branchId: galleBranch.id, role: RoleName.pharmacist },
      ...mainCashiers.map((u) => ({
        tenantId: tenant.id,
        userId: u.id,
        branchId: mainBranch.id,
        role: RoleName.cashier,
      })),
      ...branch2Cashiers.map((u) => ({
        tenantId: tenant.id,
        userId: u.id,
        branchId: secondBranch.id,
        role: RoleName.cashier,
      })),
    ],
  });

  console.log("Seeding NMRA product catalog…");
  const nmra = await seedNmraCatalog(prisma, tenant.id);
  const productBySku = nmra.productBySku;

  const supplierDefs: Array<{
    code: string;
    name: string;
    type: SupplierType;
    status: SupplierStatus;
    phone?: string;
    email?: string;
    contactName?: string;
    leadTimeDays: number;
    paymentTermsDays: number;
  }> = [
    {
      code: "SUP-001",
      name: "Lanka Pharma Distributors",
      type: SupplierType.distributor,
      status: SupplierStatus.active,
      phone: "+94 11 234 5601",
      email: "orders@lankapharma.lk",
      contactName: "Nimal Perera",
      leadTimeDays: 3,
      paymentTermsDays: 30,
    },
    {
      code: "SUP-002",
      name: "MediCare Imports (Pvt) Ltd",
      type: SupplierType.importer,
      status: SupplierStatus.active,
      phone: "+94 11 255 7800",
      email: "ap@medicareimports.lk",
      contactName: "Shalini Fernando",
      leadTimeDays: 5,
      paymentTermsDays: 45,
    },
    {
      code: "SUP-003",
      name: "Colombo Medical Supplies",
      type: SupplierType.wholesaler,
      status: SupplierStatus.active,
      phone: "+94 11 268 3344",
      email: "sales@colombomedical.lk",
      contactName: "Ruwan Silva",
      leadTimeDays: 2,
      paymentTermsDays: 14,
    },
    {
      code: "SUP-004",
      name: "Ceylon Generics Manufacturing",
      type: SupplierType.manufacturer,
      status: SupplierStatus.active,
      phone: "+94 81 222 1100",
      email: "supply@ceylongenerics.lk",
      contactName: "Anusha Jayawardena",
      leadTimeDays: 7,
      paymentTermsDays: 30,
    },
    {
      code: "SUP-005",
      name: "Island OTC Wholesalers",
      type: SupplierType.wholesaler,
      status: SupplierStatus.active,
      phone: "+94 11 250 9911",
      email: "desk@islandotc.lk",
      contactName: "Kasun Bandara",
      leadTimeDays: 2,
      paymentTermsDays: 7,
    },
    {
      code: "SUP-006",
      name: "Hemas Pharmaceuticals",
      type: SupplierType.distributor,
      status: SupplierStatus.active,
      phone: "+94 11 473 0730",
      email: "pharma.orders@hemas.com",
      contactName: "Dilani Wickramasinghe",
      leadTimeDays: 4,
      paymentTermsDays: 30,
    },
    {
      code: "SUP-007",
      name: "Astron Limited",
      type: SupplierType.manufacturer,
      status: SupplierStatus.on_hold,
      phone: "+94 11 258 8444",
      email: "accounts@astron.lk",
      contactName: "Pradeep Gunasekara",
      leadTimeDays: 10,
      paymentTermsDays: 60,
    },
    {
      code: "SUP-008",
      name: "Softlogic Pharma Hub",
      type: SupplierType.distributor,
      status: SupplierStatus.active,
      phone: "+94 11 557 5000",
      email: "pharmacy@softlogic.lk",
      contactName: "Mevan Cooray",
      leadTimeDays: 3,
      paymentTermsDays: 21,
    },
    {
      code: "SUP-009",
      name: "Global Med Asia Imports",
      type: SupplierType.importer,
      status: SupplierStatus.active,
      phone: "+94 11 230 6677",
      email: "finance@globalmedasia.com",
      contactName: "Farah Ismail",
      leadTimeDays: 14,
      paymentTermsDays: 45,
    },
    {
      code: "SUP-010",
      name: "Kandy Drug Store Supplies",
      type: SupplierType.other,
      status: SupplierStatus.inactive,
      phone: "+94 81 223 4455",
      email: "info@kandydrugs.lk",
      contactName: "Chaminda Rathnayake",
      leadTimeDays: 5,
      paymentTermsDays: 30,
    },
    {
      code: "SUP-011",
      name: "Sunrise Nutraceuticals",
      type: SupplierType.wholesaler,
      status: SupplierStatus.active,
      phone: "+94 11 276 8800",
      email: "b2b@sunrisenutra.lk",
      contactName: "Ishara Mendis",
      leadTimeDays: 3,
      paymentTermsDays: 15,
    },
    {
      code: "SUP-012",
      name: "Pacific Biotech Lanka",
      type: SupplierType.importer,
      status: SupplierStatus.active,
      phone: "+94 11 269 1200",
      email: "ap@pacificbiotech.lk",
      contactName: "Tharindu Perera",
      leadTimeDays: 8,
      paymentTermsDays: 30,
    },
  ];

  const supplierByCode = new Map<string, string>();
  for (const s of supplierDefs) {
    const isActive = s.status !== SupplierStatus.inactive;
    const row = await prisma.supplier.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: s.code } },
      update: {
        name: s.name,
        type: s.type,
        status: s.status,
        phone: s.phone,
        email: s.email,
        contactName: s.contactName,
        leadTimeDays: s.leadTimeDays,
        paymentTermsDays: s.paymentTermsDays,
        isActive,
      },
      create: {
        tenantId: tenant.id,
        code: s.code,
        name: s.name,
        type: s.type,
        status: s.status,
        phone: s.phone,
        email: s.email,
        contactName: s.contactName,
        leadTimeDays: s.leadTimeDays,
        paymentTermsDays: s.paymentTermsDays,
        isActive,
      },
    });
    supplierByCode.set(s.code, row.id);
  }

  const supplier1 = { id: supplierByCode.get("SUP-001")!, paymentTermsDays: 30 };
  const supplier2 = { id: supplierByCode.get("SUP-002")!, paymentTermsDays: 45 };
  // Rotation used to tag every directly-received demo batch with a plausible supplier — Batch
  // now carries `supplierId` directly rather than relying solely on the PO→GRN→Supplier chain
  // (which is empty for batches received outside a formal PO, same as a manual stock adjustment
  // in the real app), so Near Expiry / Batch Risk's supplier filter has real lineage to filter on.
  const allSupplierIds = [...supplierByCode.values()];

  // Extra demo search synonyms for stocked items (NMRA already seeds reg/brand aliases).
  const aliasDefs = [
    { sku: "PCL-0001", aliases: ["Panadol", "Paracetamol 500", "PCM 500"] },
    { sku: "PCL-0002", aliases: ["Amoxil", "Amoxicillin caps"] },
    { sku: "PCL-0005", aliases: ["Zyrtec", "Cetirizine"] },
    { sku: "PCL-0021", aliases: ["MS Contin", "Morphine 10mg"] },
    { sku: "PCL-0026", aliases: ["Lantus", "Insulin glargine"] },
  ];
  for (const a of aliasDefs) {
    const productId = productBySku.get(a.sku);
    if (!productId) continue;
    for (const text of a.aliases) {
      await prisma.productAlias.create({
        data: { tenantId: tenant.id, productId, aliasText: text, aliasType: "synonym" },
      }).catch(() => undefined);
    }
  }

  const batchByKey = new Map<string, { batchId: string; productId: string; sellingPrice: Prisma.Decimal }>();
  const seedGrId = "00000000-0000-4000-8000-000000000001";

  for (let i = 0; i < MAIN_STOCK.length; i++) {
    const line = MAIN_STOCK[i];
    // Stagger primary expiries ~4–18 months ahead (2026-11 … 2027-12), not a near-expiry flood.
    const monthsAhead = 4 + Math.round((i / Math.max(1, MAIN_STOCK.length - 1)) * 14);
    const expiry = new Date(Date.UTC(2026, 6, 15));
    expiry.setUTCMonth(expiry.getUTCMonth() + monthsAhead);
    const productId = productBySku.get(line.sku)!;
    const ref = await seedReceiveStock(prisma, {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId,
      userId: inventoryClerk.id,
      batchNo: `SEED-${line.sku}-A`,
      expiryDate: dateOnly(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 15),
      qty: line.qty,
      costPrice: line.cost,
      sellingPrice: line.sell,
      referenceId: seedGrId,
      // Staggered 20–230 days back (not a flat 45) so Stock Health's 6-month ageing trend has a
      // real distribution to show instead of a cliff of "everything is 45 days old" — products
      // that later get replenished by seedDemoOps' weekly cycle skew back toward fresh, so this
      // naturally correlates "still on its founding batch" with "slow mover," same as real life.
      receivedAt: daysAgo(20 + Math.round((i / Math.max(1, MAIN_STOCK.length - 1)) * 210)),
      supplierId: allSupplierIds[i % allSupplierIds.length],
    });
    batchByKey.set(`MAIN:${line.sku}`, ref);
  }

  // Expanded demo inventory beyond the ~30 PCL ops keys (batches for Inventory/POS demos).
  const pclRegs = new Set(Object.values(DEMO_STOCK_REG_NOS));
  const expandedRegs = nmra.demoStockRegNos.filter((reg) => !pclRegs.has(reg));
  const nmraByReg = new Map(nmra.products.map((p) => [p.registrationNo, p]));
  const seedGrExpandedId = "00000000-0000-4000-8000-0000000000e1";
  let expandedStocked = 0;
  for (let i = 0; i < expandedRegs.length; i++) {
    const regNo = expandedRegs[i]!;
    const productId = productBySku.get(regNo);
    if (!productId) continue;
    const meta = nmraByReg.get(regNo);
    const line = meta
      ? demoPricingForProduct(
          {
            schedule: meta.schedule,
            isControlled: meta.isControlled,
            dosageFormGroup: meta.dosageFormGroup,
          },
          i,
        )
      : demoStockLineForIndex(i);
    const monthsAhead = 5 + (i % 14);
    const expiry = new Date(Date.UTC(2026, 8, 1));
    expiry.setUTCMonth(expiry.getUTCMonth() + monthsAhead);
    await seedReceiveStock(prisma, {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId,
      userId: inventoryClerk.id,
      batchNo: `SEED-X-${regNo}-A`,
      expiryDate: dateOnly(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 10),
      qty: line.qty,
      costPrice: line.cost,
      sellingPrice: line.sell,
      referenceId: seedGrExpandedId,
      // Staggered across the same wide window as MAIN_STOCK above, for the same reason.
      receivedAt: daysAgo(15 + ((i * 13) % 220)),
      supplierId: allSupplierIds[i % allSupplierIds.length],
    });
    expandedStocked += 1;
    if ((i + 1) % 100 === 0 || i + 1 === expandedRegs.length) {
      console.log(`  Expanded MAIN stock: ${i + 1}/${expandedRegs.length}`);
    }
  }
  console.log(
    `Demo inventory stocked: ${MAIN_STOCK.length} PCL ops SKUs + ${expandedStocked} expanded = ${MAIN_STOCK.length + expandedStocked} MAIN batches (selection ${nmra.demoStockRegNos.length})`,
  );

  const seedGrNearId = "00000000-0000-4000-8000-000000000003";
  const nearExpiryLines: Array<{ sku: string; qty: number; daysUntilExpiry: number; suffix: string }> =
    [
      { sku: "PCL-0005", qty: 12, daysUntilExpiry: 8, suffix: "NEAR-A" },
      { sku: "PCL-0017", qty: 6, daysUntilExpiry: 14, suffix: "NEAR-B" },
      { sku: "PCL-0024", qty: 4, daysUntilExpiry: 22, suffix: "NEAR-C" },
      { sku: "PCL-0013", qty: 8, daysUntilExpiry: 5, suffix: "NEAR-D" },
    ];
  for (const [i, line] of nearExpiryLines.entries()) {
    const productId = productBySku.get(line.sku)!;
    const stock = MAIN_STOCK.find((s) => s.sku === line.sku);
    await seedReceiveStock(prisma, {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId,
      userId: inventoryClerk.id,
      batchNo: `SEED-${line.sku}-${line.suffix}`,
      expiryDate: daysFromNow(line.daysUntilExpiry),
      qty: line.qty,
      costPrice: stock?.cost ?? 50,
      sellingPrice: stock?.sell ?? 75,
      referenceId: seedGrNearId,
      receivedAt: daysAgo(60),
      supplierId: allSupplierIds[i % allSupplierIds.length],
    });
  }

  const expiredLine = { sku: "PCL-0018", qty: 5 };
  const expiredStock = MAIN_STOCK.find((s) => s.sku === expiredLine.sku);
  const expiredRef = await seedReceiveStock(prisma, {
    tenantId: tenant.id,
    branchId: mainBranch.id,
    productId: productBySku.get(expiredLine.sku)!,
    userId: inventoryClerk.id,
    batchNo: "SEED-PCL-0018-EXPIRED",
    expiryDate: daysFromNow(-18),
    qty: expiredLine.qty,
    costPrice: expiredStock?.cost ?? 8,
    sellingPrice: expiredStock?.sell ?? 15,
    referenceId: seedGrNearId,
    receivedAt: daysAgo(120),
    supplierId: supplier1.id,
  });
  await prisma.batch.update({
    where: { id: expiredRef.batchId },
    data: {
      isQuarantined: true,
      quarantinedAt: new Date(),
      quarantineReason: "Expired — auto seed quarantine",
    },
  });

  const seedGr2Id = "00000000-0000-4000-8000-000000000002";
  for (const [i, line] of BRANCH2_STOCK.entries()) {
    const productId = productBySku.get(line.sku)!;
    const ref = await seedReceiveStock(prisma, {
      tenantId: tenant.id,
      branchId: secondBranch.id,
      productId,
      userId: inventoryClerk.id,
      batchNo: `SEED-${line.sku}-KDY`,
      expiryDate: dateOnly(2027, 3, 1),
      qty: line.qty,
      costPrice: line.cost,
      sellingPrice: line.sell,
      referenceId: seedGr2Id,
      receivedAt: daysAgo(30),
      supplierId: allSupplierIds[i % allSupplierIds.length],
    });
    batchByKey.set(`BRANCH2:${line.sku}`, ref);
  }

  const poIssued = await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      supplierId: supplier1.id,
      poNumber: "PO-MAIN-SEED-001",
      status: PoStatus.partially_received,
      priority: PoPriority.normal,
      expectedOn: daysAgo(-10),
      createdAt: daysAgo(20),
      notes: "Demo PO — partially received for testing",
      paymentTermsDays: supplier1.paymentTermsDays,
      createdBy: manager.id,
      items: {
        create: [
          { tenantId: tenant.id, productId: productBySku.get("PCL-0010")!, orderedQty: 50, unitCost: dec(200) },
          { tenantId: tenant.id, productId: productBySku.get("PCL-0016")!, orderedQty: 40, unitCost: dec(60) },
          { tenantId: tenant.id, productId: productBySku.get("PCL-0026")!, orderedQty: 20, unitCost: dec(1150) },
        ],
      },
    },
    include: { items: true },
  });

  const grPartial = await prisma.goodsReceipt.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      purchaseOrderId: poIssued.id,
      grnNumber: "GRN-MAIN-SEED-001",
      receivedOn: dateOnly(2026, 4, 10),
      receivedBy: inventoryClerk.id,
    },
  });

  const poLineAzith = poIssued.items.find((i) => i.productId === productBySku.get("PCL-0010"))!;
  const extraBatchAzith = await prisma.batch.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId: poLineAzith.productId,
      batchNo: "PO-BATCH-AZITH-001",
      expiryDate: dateOnly(2027, 3, 1),
      costPrice: dec(205),
      sellingPrice: dec(290),
    },
  });
  await prisma.goodsReceiptItem.create({
    data: {
      tenantId: tenant.id,
      goodsReceiptId: grPartial.id,
      productId: poLineAzith.productId,
      batchId: extraBatchAzith.id,
      receivedQty: 25,
    },
  });
  await prisma.stockLedger.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId: poLineAzith.productId,
      batchId: extraBatchAzith.id,
      movementType: StockMovementType.purchase_in,
      qtyDelta: 25,
      referenceType: "goods_receipt",
      referenceId: grPartial.id,
      createdBy: inventoryClerk.id,
    },
  });

  await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      supplierId: supplier2.id,
      poNumber: "PO-MAIN-SEED-DRAFT",
      status: PoStatus.draft,
      priority: PoPriority.normal,
      expectedOn: daysAgo(-14),
      createdAt: daysAgo(2),
      notes: "Draft PO for purchasing UI testing",
      paymentTermsDays: supplier2.paymentTermsDays,
      createdBy: inventoryClerk.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0004")!,
            orderedQty: 100,
            unitCost: dec(52),
            taxPercent: dec(18),
          },
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0011")!,
            orderedQty: 15,
            unitCost: dec(440),
            taxPercent: dec(18),
          },
        ],
      },
    },
  });

  await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      supplierId: supplier1.id,
      poNumber: "PO-MAIN-SEED-PENDING",
      status: PoStatus.pending_approval,
      priority: PoPriority.high,
      expectedOn: daysAgo(-21),
      createdAt: daysAgo(3),
      supplierReference: "CMS-Q-2026-SEED",
      notes: "Awaiting manager approval",
      deliveryInstructions: "Deliver to main warehouse receiving bay.",
      paymentTermsDays: 30,
      shippingCharges: dec(500),
      createdBy: inventoryClerk.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0001")!,
            orderedQty: 200,
            unitCost: dec(32),
            taxPercent: dec(18),
          },
        ],
      },
    },
  });

  await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      supplierId: supplier1.id,
      poNumber: "PO-MAIN-SEED-OVERDUE",
      status: PoStatus.issued,
      priority: PoPriority.urgent,
      expectedOn: daysAgo(12),
      createdAt: daysAgo(40),
      notes: "Issued but past expected delivery — overdue demo",
      paymentTermsDays: 30,
      createdBy: manager.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0009")!,
            orderedQty: 80,
            unitCost: dec(45),
            taxPercent: dec(18),
          },
        ],
      },
    },
  });

  const poReceived = await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      supplierId: supplier2.id,
      poNumber: "PO-MAIN-SEED-RECEIVED",
      status: PoStatus.received,
      priority: PoPriority.normal,
      expectedOn: daysAgo(18),
      createdAt: daysAgo(35),
      notes: "Fully received PO for dashboard demo",
      paymentTermsDays: supplier2.paymentTermsDays,
      createdBy: manager.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0012")!,
            orderedQty: 60,
            unitCost: dec(30),
            taxPercent: dec(18),
          },
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0015")!,
            orderedQty: 40,
            unitCost: dec(45),
            taxPercent: dec(18),
          },
        ],
      },
    },
    include: { items: true },
  });

  const grReceived = await prisma.goodsReceipt.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      purchaseOrderId: poReceived.id,
      grnNumber: "GRN-MAIN-SEED-RECEIVED",
      receivedOn: daysAgo(18),
      receivedBy: manager.id,
    },
  });

  const receivedBatchSpecs: Array<{
    sku: string;
    batchNo: string;
    expiry: Date;
    cost: number;
    sell: number;
  }> = [
    {
      sku: "PCL-0012",
      batchNo: "PO-BATCH-METO-RCV",
      expiry: dateOnly(2027, 6, 1),
      cost: 30,
      sell: 45,
    },
    {
      sku: "PCL-0015",
      batchNo: "PO-BATCH-PANT-RCV",
      expiry: dateOnly(2027, 8, 1),
      cost: 45,
      sell: 65,
    },
  ];
  for (const spec of receivedBatchSpecs) {
    const poLine = poReceived.items.find((i) => i.productId === productBySku.get(spec.sku))!;
    const batch = await prisma.batch.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        productId: poLine.productId,
        batchNo: spec.batchNo,
        expiryDate: spec.expiry,
        costPrice: dec(spec.cost),
        sellingPrice: dec(spec.sell),
      },
    });
    await prisma.goodsReceiptItem.create({
      data: {
        tenantId: tenant.id,
        goodsReceiptId: grReceived.id,
        productId: poLine.productId,
        batchId: batch.id,
        receivedQty: poLine.orderedQty,
      },
    });
    await prisma.stockLedger.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        productId: poLine.productId,
        batchId: batch.id,
        movementType: StockMovementType.purchase_in,
        qtyDelta: poLine.orderedQty,
        referenceType: "goods_receipt",
        referenceId: grReceived.id,
        createdBy: manager.id,
        occurredAt: daysAgo(18),
      },
    });
  }

  const poShort = await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      supplierId: supplier1.id,
      poNumber: "PO-MAIN-SEED-SHORT",
      status: PoStatus.short_closed,
      priority: PoPriority.normal,
      expectedOn: daysAgo(8),
      createdAt: daysAgo(28),
      notes: "Short-closed — supplier could not fulfill remainder",
      paymentTermsDays: 30,
      createdBy: manager.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0020")!,
            orderedQty: 100,
            unitCost: dec(12),
            taxPercent: dec(18),
          },
        ],
      },
    },
    include: { items: true },
  });

  const grShort = await prisma.goodsReceipt.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      purchaseOrderId: poShort.id,
      grnNumber: "GRN-MAIN-SEED-SHORT",
      receivedOn: daysAgo(10),
      receivedBy: inventoryClerk.id,
    },
  });
  const shortLine = poShort.items[0]!;
  const shortBatch = await prisma.batch.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId: shortLine.productId,
      batchNo: "PO-BATCH-SHORT-001",
      expiryDate: dateOnly(2027, 11, 1),
      costPrice: dec(12),
      sellingPrice: dec(20),
    },
  });
  await prisma.goodsReceiptItem.create({
    data: {
      tenantId: tenant.id,
      goodsReceiptId: grShort.id,
      productId: shortLine.productId,
      batchId: shortBatch.id,
      receivedQty: 40,
    },
  });
  await prisma.stockLedger.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId: shortLine.productId,
      batchId: shortBatch.id,
      movementType: StockMovementType.purchase_in,
      qtyDelta: 40,
      referenceType: "goods_receipt",
      referenceId: grShort.id,
      createdBy: inventoryClerk.id,
      occurredAt: daysAgo(10),
    },
  });

  await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      supplierId: supplier1.id,
      poNumber: "PO-MAIN-SEED-CANCELLED",
      status: PoStatus.cancelled,
      priority: PoPriority.low,
      expectedOn: daysAgo(5),
      createdAt: daysAgo(25),
      notes: "Cancelled after supplier stock-out",
      paymentTermsDays: 30,
      createdBy: manager.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0011")!,
            orderedQty: 10,
            unitCost: dec(430),
            taxPercent: dec(18),
          },
        ],
      },
    },
  });

  // ── Supplier invoices (AP) ────────────────────────────────────────────────
  const invoiceSeeds: Array<{
    code: string;
    invoiceNumber: string;
    invoiceDaysAgo: number;
    dueDaysFromInvoice: number;
    total: number;
    paid: number;
    status: SupplierInvoiceStatus;
    notes?: string;
    goodsReceiptId?: string;
  }> = [
    {
      code: "SUP-001",
      invoiceNumber: "SINV-SEED-0001",
      invoiceDaysAgo: 40,
      dueDaysFromInvoice: 30,
      total: 185000,
      paid: 185000,
      status: SupplierInvoiceStatus.paid,
      notes: "Settled April cycle",
    },
    {
      code: "SUP-001",
      invoiceNumber: "SINV-SEED-0002",
      invoiceDaysAgo: 20,
      dueDaysFromInvoice: 30,
      total: 94250.5,
      paid: 40000,
      status: SupplierInvoiceStatus.partial,
      notes: "Partial payment on GRN-MAIN-SEED-001",
      goodsReceiptId: grPartial.id,
    },
    {
      code: "SUP-001",
      invoiceNumber: "SINV-SEED-0003",
      invoiceDaysAgo: 5,
      dueDaysFromInvoice: 30,
      total: 67200,
      paid: 0,
      status: SupplierInvoiceStatus.open,
    },
    {
      code: "SUP-002",
      invoiceNumber: "SINV-SEED-0004",
      invoiceDaysAgo: 50,
      dueDaysFromInvoice: 45,
      total: 210400,
      paid: 0,
      status: SupplierInvoiceStatus.open,
      notes: "Overdue import shipment",
    },
    {
      code: "SUP-002",
      invoiceNumber: "SINV-SEED-0005",
      invoiceDaysAgo: 18,
      dueDaysFromInvoice: 45,
      total: 52800,
      paid: 52800,
      status: SupplierInvoiceStatus.paid,
      goodsReceiptId: grReceived.id,
    },
    {
      code: "SUP-003",
      invoiceNumber: "SINV-SEED-0006",
      invoiceDaysAgo: 25,
      dueDaysFromInvoice: 14,
      total: 31800,
      paid: 10000,
      status: SupplierInvoiceStatus.partial,
    },
    {
      code: "SUP-004",
      invoiceNumber: "SINV-SEED-0007",
      invoiceDaysAgo: 12,
      dueDaysFromInvoice: 30,
      total: 145600,
      paid: 0,
      status: SupplierInvoiceStatus.open,
    },
    {
      code: "SUP-005",
      invoiceNumber: "SINV-SEED-0008",
      invoiceDaysAgo: 16,
      dueDaysFromInvoice: 7,
      total: 22450,
      paid: 0,
      status: SupplierInvoiceStatus.open,
      notes: "OTC restock — overdue",
    },
    {
      code: "SUP-006",
      invoiceNumber: "SINV-SEED-0009",
      invoiceDaysAgo: 8,
      dueDaysFromInvoice: 30,
      total: 88900,
      paid: 25000,
      status: SupplierInvoiceStatus.partial,
    },
    {
      code: "SUP-008",
      invoiceNumber: "SINV-SEED-0010",
      invoiceDaysAgo: 3,
      dueDaysFromInvoice: 21,
      total: 45600,
      paid: 0,
      status: SupplierInvoiceStatus.open,
    },
    {
      code: "SUP-009",
      invoiceNumber: "SINV-SEED-0011",
      invoiceDaysAgo: 60,
      dueDaysFromInvoice: 45,
      total: 99000,
      paid: 99000,
      status: SupplierInvoiceStatus.paid,
    },
    {
      code: "SUP-011",
      invoiceNumber: "SINV-SEED-0012",
      invoiceDaysAgo: 10,
      dueDaysFromInvoice: 15,
      total: 15600,
      paid: 0,
      status: SupplierInvoiceStatus.open,
    },
    {
      code: "SUP-012",
      invoiceNumber: "SINV-SEED-0013",
      invoiceDaysAgo: 2,
      dueDaysFromInvoice: 30,
      total: 73400,
      paid: 0,
      status: SupplierInvoiceStatus.open,
    },
    {
      code: "SUP-007",
      invoiceNumber: "SINV-SEED-0014",
      invoiceDaysAgo: 90,
      dueDaysFromInvoice: 60,
      total: 12000,
      paid: 0,
      status: SupplierInvoiceStatus.voided,
      notes: "Voided — credit note pending",
    },
  ];

  for (const inv of invoiceSeeds) {
    const supplierId = supplierByCode.get(inv.code);
    if (!supplierId) continue;
    const invoiceDate = daysAgo(inv.invoiceDaysAgo);
    const dueDate = new Date(invoiceDate);
    dueDate.setUTCDate(dueDate.getUTCDate() + inv.dueDaysFromInvoice);
    await prisma.supplierInvoice.create({
      data: {
        tenantId: tenant.id,
        supplierId,
        branchId: mainBranch.id,
        invoiceNumber: inv.invoiceNumber,
        goodsReceiptId: inv.goodsReceiptId,
        invoiceDate,
        dueDate,
        totalAmount: dec(inv.total),
        paidAmount: dec(inv.paid),
        status: inv.status,
        notes: inv.notes,
      },
    });
  }

  const salesDefs: Array<{
    invoiceNo: string;
    daysAgo: number;
    lines: Array<{ sku: string; qty: number }>;
    voided?: boolean;
  }> = [
    { invoiceNo: "INV-SEED-0001", daysAgo: 14, lines: [{ sku: "PCL-0001", qty: 2 }, { sku: "PCL-0009", qty: 1 }] },
    { invoiceNo: "INV-SEED-0002", daysAgo: 12, lines: [{ sku: "PCL-0003", qty: 3 }] },
    { invoiceNo: "INV-SEED-0003", daysAgo: 10, lines: [{ sku: "PCL-0002", qty: 1 }, { sku: "PCL-0019", qty: 2 }] },
    { invoiceNo: "INV-SEED-0004", daysAgo: 9, lines: [{ sku: "PCL-0005", qty: 4 }] },
    { invoiceNo: "INV-SEED-0005", daysAgo: 8, lines: [{ sku: "PCL-0006", qty: 2 }, { sku: "PCL-0007", qty: 1 }] },
    { invoiceNo: "INV-SEED-0006", daysAgo: 7, lines: [{ sku: "PCL-0024", qty: 2 }, { sku: "PCL-0025", qty: 1 }] },
    { invoiceNo: "INV-SEED-0007", daysAgo: 6, lines: [{ sku: "PCL-0011", qty: 1 }] },
    { invoiceNo: "INV-SEED-0008", daysAgo: 5, lines: [{ sku: "PCL-0021", qty: 1 }] },
    { invoiceNo: "INV-SEED-0009", daysAgo: 4, lines: [{ sku: "PCL-0008", qty: 5 }, { sku: "PCL-0015", qty: 2 }] },
    { invoiceNo: "INV-SEED-0010", daysAgo: 3, lines: [{ sku: "PCL-0027", qty: 2 }, { sku: "PCL-0028", qty: 1 }] },
    { invoiceNo: "INV-SEED-0011", daysAgo: 2, lines: [{ sku: "PCL-0001", qty: 5 }, { sku: "PCL-0009", qty: 3 }] },
    { invoiceNo: "INV-SEED-0012", daysAgo: 1, lines: [{ sku: "PCL-0013", qty: 2 }] },
    { invoiceNo: "INV-SEED-0013", daysAgo: 0, lines: [{ sku: "PCL-0030", qty: 1 }, { sku: "PCL-0004", qty: 2 }] },
    { invoiceNo: "INV-SEED-0014", daysAgo: 0, lines: [{ sku: "PCL-0001", qty: 3 }, { sku: "PCL-0005", qty: 2 }] },
    { invoiceNo: "INV-SEED-0015", daysAgo: 0, lines: [{ sku: "PCL-0027", qty: 1 }, { sku: "PCL-0009", qty: 2 }] },
    { invoiceNo: "INV-SEED-VOID-01", daysAgo: 11, lines: [{ sku: "PCL-0001", qty: 10 }], voided: true },
  ];

  const extraSaleSkus: Array<{ sku: string; qty: number }> = [
    { sku: "PCL-0001", qty: 2 },
    { sku: "PCL-0003", qty: 1 },
    { sku: "PCL-0008", qty: 3 },
    { sku: "PCL-0009", qty: 2 },
    { sku: "PCL-0015", qty: 1 },
    { sku: "PCL-0027", qty: 1 },
  ];
  for (let day = 1; day <= 29; day++) {
    if (day % 2 !== 0) continue;
    const pick = extraSaleSkus[Math.floor(day / 2) % extraSaleSkus.length];
    salesDefs.push({
      invoiceNo: `INV-SEED-D${String(day).padStart(2, "0")}`,
      daysAgo: day,
      lines: [{ sku: pick.sku, qty: pick.qty }],
    });
  }

  salesDefs.push({
    invoiceNo: "INV-SEED-OUT-01",
    daysAgo: 1,
    lines: [{ sku: "PCL-0023", qty: 8 }],
  });

  let saleCount = 0;
  for (const s of salesDefs) {
    const lines = s.lines.map((l) => {
      const ref = batchByKey.get(`MAIN:${l.sku}`)!;
      return {
        productId: ref.productId,
        batchId: ref.batchId,
        qty: l.qty,
        unitPrice: ref.sellingPrice,
        discountAmount: 0,
        taxAmount: 0,
      };
    });
    const sale = await seedSale(prisma, {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      soldBy: s.voided ? pharmacist.id : cashier.id,
      invoiceNo: s.invoiceNo,
      soldAt: daysAgo(s.daysAgo),
      lines,
    });
    if (s.voided) {
      await prisma.sale.update({
        where: { id: sale.id },
        data: { status: SaleStatus.voided },
      });
      for (const l of lines) {
        await prisma.stockLedger.create({
          data: {
            tenantId: tenant.id,
            branchId: mainBranch.id,
            productId: l.productId,
            batchId: l.batchId,
            movementType: StockMovementType.sale_void_in,
            qtyDelta: l.qty,
            referenceType: "sale",
            referenceId: sale.id,
            createdBy: manager.id,
            occurredAt: daysAgo(s.daysAgo - 1),
          },
        });
      }
    }
    saleCount++;
  }

  await seedSale(prisma, {
    tenantId: tenant.id,
    branchId: secondBranch.id,
    soldBy: cashier.id,
    invoiceNo: "INV-SEED-KDY-001",
    soldAt: daysAgo(2),
    lines: [
      {
        productId: batchByKey.get("BRANCH2:PCL-0001")!.productId,
        batchId: batchByKey.get("BRANCH2:PCL-0001")!.batchId,
        qty: 3,
        unitPrice: batchByKey.get("BRANCH2:PCL-0001")!.sellingPrice,
      },
      {
        productId: batchByKey.get("BRANCH2:PCL-0009")!.productId,
        batchId: batchByKey.get("BRANCH2:PCL-0009")!.batchId,
        qty: 2,
        unitPrice: batchByKey.get("BRANCH2:PCL-0009")!.sellingPrice,
      },
    ],
  });
  saleCount++;

  let transferSeq = 1;
  const nextTransferNumber = () => `TR-SEED-${String(transferSeq++).padStart(3, "0")}`;

  const transferRequested = await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
      transferNumber: nextTransferNumber(),
      status: TransferStatus.requested,
      notes: "Restock Metformin for weekend demand",
      expectedOn: daysFromNow(5),
      requestedBy: inventoryClerk.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0003")!,
            batchId: batchByKey.get("MAIN:PCL-0003")!.batchId,
            qty: 10,
          },
        ],
      },
    },
  });

  const transferApproved = await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
      transferNumber: nextTransferNumber(),
      status: TransferStatus.approved,
      notes: "Approved multivitamin top-up",
      expectedOn: daysFromNow(3),
      requestedBy: inventoryClerk.id,
      approvedBy: manager.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0027")!,
            batchId: batchByKey.get("MAIN:PCL-0027")!.batchId,
            qty: 5,
          },
        ],
      },
    },
    include: { items: true },
  });
  for (const line of transferApproved.items) {
    if (!line.batchId) continue;
    await prisma.stockLedger.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        productId: line.productId,
        batchId: line.batchId,
        movementType: StockMovementType.transfer_reserve_out,
        qtyDelta: -line.qty,
        referenceType: "transfer",
        referenceId: transferApproved.id,
        createdBy: manager.id,
        occurredAt: daysAgo(1),
      },
    });
  }

  const transferInTransit = await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
      transferNumber: nextTransferNumber(),
      status: TransferStatus.in_transit,
      notes: "Ibuprofen dispatch in progress",
      expectedOn: daysFromNow(2),
      requestedBy: inventoryClerk.id,
      approvedBy: manager.id,
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0009")!,
            batchId: batchByKey.get("MAIN:PCL-0009")!.batchId,
            qty: 15,
          },
        ],
      },
    },
    include: { items: true },
  });

  for (const line of transferInTransit.items) {
    if (!line.batchId) continue;
    await prisma.stockLedger.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        productId: line.productId,
        batchId: line.batchId,
        movementType: StockMovementType.transfer_out,
        qtyDelta: -line.qty,
        referenceType: "transfer",
        referenceId: transferInTransit.id,
        createdBy: manager.id,
        occurredAt: daysAgo(3),
      },
    });
  }

  const transferPartial = await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
      transferNumber: nextTransferNumber(),
      status: TransferStatus.partially_received,
      notes: "Partial receipt — remaining units still in transit",
      expectedOn: daysAgo(-1),
      requestedBy: inventoryClerk.id,
      approvedBy: manager.id,
      receivedBy: manager.id,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(2),
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0008")!,
            batchId: batchByKey.get("MAIN:PCL-0008")!.batchId,
            qty: 20,
            receivedQty: 8,
          },
        ],
      },
    },
    include: { items: true },
  });

  for (const line of transferPartial.items) {
    if (!line.batchId) continue;
    await prisma.stockLedger.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        productId: line.productId,
        batchId: line.batchId,
        movementType: StockMovementType.transfer_out,
        qtyDelta: -line.qty,
        referenceType: "transfer",
        referenceId: transferPartial.id,
        createdBy: manager.id,
        occurredAt: daysAgo(8),
      },
    });
    const src = await prisma.batch.findFirst({ where: { id: line.batchId } });
    if (!src) continue;
    const destPartial = await prisma.batch.create({
      data: {
        tenantId: tenant.id,
        branchId: secondBranch.id,
        productId: line.productId,
        batchNo: "SEED-PCL-0008-TR-PARTIAL",
        expiryDate: src.expiryDate,
        costPrice: src.costPrice,
        sellingPrice: src.sellingPrice,
      },
    });
    await prisma.stockLedger.create({
      data: {
        tenantId: tenant.id,
        branchId: secondBranch.id,
        productId: line.productId,
        batchId: destPartial.id,
        movementType: StockMovementType.transfer_in,
        qtyDelta: line.receivedQty,
        referenceType: "transfer",
        referenceId: transferPartial.id,
        createdBy: manager.id,
        occurredAt: daysAgo(2),
      },
    });
  }

  const transferReceived = await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
      transferNumber: nextTransferNumber(),
      status: TransferStatus.received,
      notes: "Paracetamol restock completed",
      expectedOn: daysAgo(6),
      requestedBy: inventoryClerk.id,
      approvedBy: manager.id,
      receivedBy: manager.id,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(5),
      items: {
        create: [
          {
            tenantId: tenant.id,
            productId: productBySku.get("PCL-0001")!,
            batchId: batchByKey.get("MAIN:PCL-0001")!.batchId,
            qty: 20,
            receivedQty: 20,
          },
        ],
      },
    },
    include: { items: true },
  });

  const mainParacetamolBatch = await prisma.batch.findFirst({
    where: { id: batchByKey.get("MAIN:PCL-0001")!.batchId },
  });
  for (const line of transferReceived.items) {
    if (!line.batchId || !mainParacetamolBatch) continue;
    await prisma.stockLedger.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        productId: line.productId,
        batchId: line.batchId,
        movementType: StockMovementType.transfer_out,
        qtyDelta: -line.qty,
        referenceType: "transfer",
        referenceId: transferReceived.id,
        createdBy: manager.id,
        occurredAt: daysAgo(8),
      },
    });
    const destBatch = await prisma.batch.create({
      data: {
        tenantId: tenant.id,
        branchId: secondBranch.id,
        productId: line.productId,
        batchNo: "SEED-PCL-0001-TR-RCV",
        expiryDate: mainParacetamolBatch.expiryDate,
        costPrice: mainParacetamolBatch.costPrice,
        sellingPrice: mainParacetamolBatch.sellingPrice,
      },
    });
    await prisma.stockLedger.create({
      data: {
        tenantId: tenant.id,
        branchId: secondBranch.id,
        productId: line.productId,
        batchId: destBatch.id,
        movementType: StockMovementType.transfer_in,
        qtyDelta: line.qty,
        referenceType: "transfer",
        referenceId: transferReceived.id,
        createdBy: manager.id,
        occurredAt: daysAgo(5),
      },
    });
  }

  type TransferSeedDef = {
    from: "MAIN" | "BRANCH2";
    to: "MAIN" | "BRANCH2";
    status: TransferStatus;
    daysAgo: number;
    lines: Array<{ sku: string; qty: number }>;
    staleDays?: number;
    expectedInDays?: number;
    notes?: string;
  };

  const extraTransferDefs: TransferSeedDef[] = [
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.requested, daysAgo: 2, lines: [{ sku: "PCL-0001", qty: 8 }], expectedInDays: 4, notes: "Paracetamol request" },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.requested, daysAgo: 6, lines: [{ sku: "PCL-0006", qty: 4 }], expectedInDays: 2 },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.requested, daysAgo: 9, lines: [{ sku: "PCL-0015", qty: 6 }], expectedInDays: 1 },
    { from: "BRANCH2", to: "MAIN", status: TransferStatus.requested, daysAgo: 3, lines: [{ sku: "PCL-0009", qty: 10 }], expectedInDays: 5 },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.approved, daysAgo: 4, lines: [{ sku: "PCL-0004", qty: 12 }], expectedInDays: 3 },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.approved, daysAgo: 7, lines: [{ sku: "PCL-0012", qty: 8 }], expectedInDays: 2 },
    { from: "BRANCH2", to: "MAIN", status: TransferStatus.approved, daysAgo: 5, lines: [{ sku: "PCL-0003", qty: 6 }], expectedInDays: 4 },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.in_transit, daysAgo: 8, lines: [{ sku: "PCL-0007", qty: 10 }], staleDays: 14, expectedInDays: -5, notes: "Overdue Losartan shipment" },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.in_transit, daysAgo: 10, lines: [{ sku: "PCL-0010", qty: 5 }], staleDays: 11, expectedInDays: -3 },
    { from: "BRANCH2", to: "MAIN", status: TransferStatus.in_transit, daysAgo: 6, lines: [{ sku: "PCL-0001", qty: 4 }], expectedInDays: 1 },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.received, daysAgo: 25, lines: [{ sku: "PCL-0008", qty: 20 }], expectedInDays: -20 },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.received, daysAgo: 18, lines: [{ sku: "PCL-0019", qty: 15 }], expectedInDays: -14 },
    { from: "BRANCH2", to: "MAIN", status: TransferStatus.received, daysAgo: 12, lines: [{ sku: "PCL-0027", qty: 8 }], expectedInDays: -8 },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.cancelled, daysAgo: 15, lines: [{ sku: "PCL-0011", qty: 3 }], notes: "Cancelled — stock no longer needed" },
    { from: "MAIN", to: "BRANCH2", status: TransferStatus.rejected, daysAgo: 11, lines: [{ sku: "PCL-0022", qty: 2 }], notes: "Rejected — insufficient controlled-substance justification" },
  ];

  for (const def of extraTransferDefs) {
    const fromBranch = def.from === "MAIN" ? mainBranch : secondBranch;
    const toBranch = def.to === "MAIN" ? mainBranch : secondBranch;
    const prefix = def.from === "MAIN" ? "MAIN" : "BRANCH2";
    const createdAt = daysAgo(def.daysAgo);
    const needsApproval =
      def.status !== TransferStatus.requested &&
      def.status !== TransferStatus.cancelled &&
      def.status !== TransferStatus.rejected;
    const isReceived = def.status === TransferStatus.received;
    const transfer = await prisma.transfer.create({
      data: {
        tenantId: tenant.id,
        fromBranchId: fromBranch.id,
        toBranchId: toBranch.id,
        transferNumber: nextTransferNumber(),
        status: def.status,
        notes: def.notes ?? null,
        expectedOn:
          def.expectedInDays != null ? daysFromNow(def.expectedInDays) : null,
        requestedBy: inventoryClerk.id,
        approvedBy: needsApproval ? manager.id : null,
        receivedBy: isReceived ? manager.id : null,
        createdAt,
        updatedAt: def.staleDays ? daysAgo(def.staleDays) : createdAt,
        items: {
          create: def.lines.map((line) => ({
            tenantId: tenant.id,
            productId: productBySku.get(line.sku)!,
            batchId: batchByKey.get(`${prefix}:${line.sku}`)!.batchId,
            qty: line.qty,
            receivedQty: isReceived ? line.qty : 0,
          })),
        },
      },
      include: { items: true },
    });

    if (def.status === TransferStatus.approved) {
      for (const line of transfer.items) {
        if (!line.batchId) continue;
        await prisma.stockLedger.create({
          data: {
            tenantId: tenant.id,
            branchId: fromBranch.id,
            productId: line.productId,
            batchId: line.batchId,
            movementType: StockMovementType.transfer_reserve_out,
            qtyDelta: -line.qty,
            referenceType: "transfer",
            referenceId: transfer.id,
            createdBy: manager.id,
            occurredAt: daysAgo(Math.max(0, def.daysAgo - 1)),
          },
        });
      }
    }

    if (
      def.status === TransferStatus.in_transit ||
      def.status === TransferStatus.received
    ) {
      for (const line of transfer.items) {
        if (!line.batchId) continue;
        await prisma.stockLedger.create({
          data: {
            tenantId: tenant.id,
            branchId: fromBranch.id,
            productId: line.productId,
            batchId: line.batchId,
            movementType: StockMovementType.transfer_out,
            qtyDelta: -line.qty,
            referenceType: "transfer",
            referenceId: transfer.id,
            createdBy: manager.id,
            occurredAt: daysAgo(def.daysAgo - 1),
          },
        });
      }
    }

    if (def.status === TransferStatus.received) {
      for (const line of transfer.items) {
        if (!line.batchId) continue;
        const sourceBatch = await prisma.batch.findFirst({ where: { id: line.batchId } });
        if (!sourceBatch) continue;
        const destBatch = await prisma.batch.create({
          data: {
            tenantId: tenant.id,
            branchId: toBranch.id,
            productId: line.productId,
            batchNo: `SEED-TR-${line.productId.slice(0, 6)}-${def.daysAgo}`,
            expiryDate: sourceBatch.expiryDate,
            costPrice: sourceBatch.costPrice,
            sellingPrice: sourceBatch.sellingPrice,
          },
        });
        await prisma.stockLedger.create({
          data: {
            tenantId: tenant.id,
            branchId: toBranch.id,
            productId: line.productId,
            batchId: destBatch.id,
            movementType: StockMovementType.transfer_in,
            qtyDelta: line.qty,
            referenceType: "transfer",
            referenceId: transfer.id,
            createdBy: manager.id,
            occurredAt: daysAgo(Math.max(0, def.daysAgo - 3)),
          },
        });
      }
    }
  }

  await prisma.stockLedger.create({
    data: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId: productBySku.get("PCL-0018")!,
      batchId: batchByKey.get("MAIN:PCL-0018")!.batchId,
      movementType: StockMovementType.adjustment_out,
      qtyDelta: -3,
      referenceType: "stock_adjustment",
      referenceId: "00000000-0000-4000-8000-000000000099",
      createdBy: manager.id,
      occurredAt: daysAgo(2),
    },
  });

  const sampleProductId = productBySku.get("PCL-0001")!;
  const latestSale = await prisma.sale.findFirst({
    where: { tenantId: tenant.id, branchId: mainBranch.id, status: SaleStatus.posted },
    orderBy: { soldAt: "desc" },
  });
  await prisma.auditEvent.createMany({
    data: [
      {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        actorUserId: manager.id,
        eventName: "product.updated",
        entityName: "product",
        entityId: sampleProductId,
        payload: { sku: "PCL-0001", field: "reorderLevel", from: 40, to: 50 },
        createdAt: daysAgo(7),
      },
      {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        actorUserId: inventoryClerk.id,
        eventName: "goods_receipt.created",
        entityName: "goods_receipt",
        entityId: grPartial.id,
        payload: { grnNumber: "GRN-MAIN-SEED-001" },
        createdAt: daysAgo(20),
      },
      {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        actorUserId: inventoryClerk.id,
        eventName: "transfer.created",
        entityName: "transfer",
        entityId: transferRequested.id,
        payload: { status: "requested" },
        createdAt: daysAgo(4),
      },
      {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        actorUserId: cashier.id,
        eventName: "sale.posted",
        entityName: "sale",
        entityId: latestSale?.id ?? sampleProductId,
        payload: { invoiceNo: latestSale?.invoiceNo ?? "INV-SEED-0015" },
        createdAt: daysAgo(0),
      },
      {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        actorUserId: manager.id,
        eventName: "purchase_order.approved",
        entityName: "purchase_order",
        entityId: poIssued.id,
        payload: { poNumber: "PO-MAIN-SEED-001", status: "partially_received" },
        createdAt: daysAgo(18),
      },
      {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        actorUserId: inventoryClerk.id,
        eventName: "stock_adjustment.posted",
        entityName: "stock_ledger",
        entityId: productBySku.get("PCL-0018")!,
        payload: { movementType: "adjustment_out", qty: 3 },
        createdAt: daysAgo(2),
      },
    ],
  });

  // ── Goods returns (customer + supplier, all workflow statuses) ───────────
  const saleInv0001 = await prisma.sale.findFirst({
    where: { tenantId: tenant.id, invoiceNo: "INV-SEED-0001" },
  });
  const saleInv0002 = await prisma.sale.findFirst({
    where: { tenantId: tenant.id, invoiceNo: "INV-SEED-0002" },
  });

  type ReturnSeedDef = {
    number: string;
    type: GoodsReturnType;
    status: GoodsReturnStatus;
    daysAgo: number;
    reason: string;
    customerName?: string;
    supplierId?: string;
    saleId?: string | null;
    purchaseOrderId?: string;
    branchId?: string;
    amount: number;
    lines: { sku: string; qty: number; unitPrice: number }[];
    notes?: string;
  };

  const returnDefs: ReturnSeedDef[] = [
    { number: "RET-2026-00001", type: GoodsReturnType.customer, status: GoodsReturnStatus.draft, daysAgo: 1, reason: "Wrong strength dispensed", customerName: "Walk-in customer", amount: 450, lines: [{ sku: "PCL-0001", qty: 2, unitPrice: 225 }] },
    { number: "RET-2026-00002", type: GoodsReturnType.customer, status: GoodsReturnStatus.draft, daysAgo: 2, reason: "Customer changed mind", customerName: "Saman Perera", amount: 890, lines: [{ sku: "PCL-0009", qty: 1, unitPrice: 890 }] },
    { number: "RET-2026-00003", type: GoodsReturnType.supplier, status: GoodsReturnStatus.draft, daysAgo: 3, reason: "Damaged outer packaging", supplierId: supplier1.id, amount: 2400, lines: [{ sku: "PCL-0003", qty: 10, unitPrice: 240 }] },
    { number: "RET-2026-00004", type: GoodsReturnType.customer, status: GoodsReturnStatus.draft, daysAgo: 4, reason: "Duplicate purchase", customerName: "Nadeesha Fernando", amount: 320, lines: [{ sku: "PCL-0015", qty: 4, unitPrice: 80 }] },
    { number: "RET-2026-00005", type: GoodsReturnType.supplier, status: GoodsReturnStatus.draft, daysAgo: 5, reason: "Short-dated stock", supplierId: supplier2.id, amount: 1800, lines: [{ sku: "PCL-0012", qty: 6, unitPrice: 300 }] },
    { number: "RET-2026-00006", type: GoodsReturnType.customer, status: GoodsReturnStatus.pending_approval, daysAgo: 2, reason: "Suspected adverse reaction", customerName: "Kamani Jayasuriya", amount: 1250, lines: [{ sku: "PCL-0004", qty: 1, unitPrice: 1250 }], notes: "Pharmacist review required" },
    { number: "RET-2026-00007", type: GoodsReturnType.customer, status: GoodsReturnStatus.pending_approval, daysAgo: 3, reason: "Incorrect item on invoice", customerName: "Ruwan Silva", amount: 560, lines: [{ sku: "PCL-0008", qty: 2, unitPrice: 280 }] },
    { number: "RET-2026-00008", type: GoodsReturnType.supplier, status: GoodsReturnStatus.pending_approval, daysAgo: 4, reason: "Quality complaint", supplierId: supplier1.id, amount: 3600, lines: [{ sku: "PCL-0007", qty: 12, unitPrice: 300 }] },
    { number: "RET-2026-00009", type: GoodsReturnType.customer, status: GoodsReturnStatus.pending_approval, daysAgo: 6, reason: "Expired before use", customerName: "Priya Wickramasinghe", amount: 410, lines: [{ sku: "PCL-0010", qty: 2, unitPrice: 205 }] },
    { number: "RET-2026-00010", type: GoodsReturnType.supplier, status: GoodsReturnStatus.pending_approval, daysAgo: 7, reason: "Wrong product shipped", supplierId: supplier2.id, amount: 2100, lines: [{ sku: "PCL-0019", qty: 5, unitPrice: 420 }] },
    { number: "RET-2026-00011", type: GoodsReturnType.customer, status: GoodsReturnStatus.pending_approval, daysAgo: 8, reason: "Packaging incomplete", customerName: "Ashan Mendis", amount: 175, lines: [{ sku: "PCL-0022", qty: 1, unitPrice: 175 }] },
    { number: "RET-2026-00012", type: GoodsReturnType.customer, status: GoodsReturnStatus.pending_approval, daysAgo: 1, reason: "Doctor changed prescription", customerName: "Fathima Rizwan", amount: 980, lines: [{ sku: "PCL-0006", qty: 2, unitPrice: 490 }] },
    { number: "RET-2026-00013", type: GoodsReturnType.customer, status: GoodsReturnStatus.awaiting_logistics, daysAgo: 5, reason: "Home delivery return pickup", customerName: "Dilani Gunasekara", amount: 640, lines: [{ sku: "PCL-0011", qty: 2, unitPrice: 320 }] },
    { number: "RET-2026-00014", type: GoodsReturnType.supplier, status: GoodsReturnStatus.awaiting_logistics, daysAgo: 6, reason: "Recall — batch hold", supplierId: supplier1.id, purchaseOrderId: poIssued.id, amount: 5200, lines: [{ sku: "PCL-0027", qty: 8, unitPrice: 650 }] },
    { number: "RET-2026-00015", type: GoodsReturnType.customer, status: GoodsReturnStatus.awaiting_logistics, daysAgo: 9, reason: "Customer bringing unused pack", customerName: "Heshan Bandara", amount: 295, lines: [{ sku: "PCL-0018", qty: 1, unitPrice: 295 }] },
    { number: "RET-2026-00016", type: GoodsReturnType.supplier, status: GoodsReturnStatus.awaiting_logistics, daysAgo: 10, reason: "Overstock return to supplier", supplierId: supplier2.id, amount: 1500, lines: [{ sku: "PCL-0003", qty: 5, unitPrice: 300 }] },
    { number: "RET-2026-00017", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 4, reason: "Condition check after pickup", customerName: "Malsha Perera", amount: 720, lines: [{ sku: "PCL-0009", qty: 1, unitPrice: 720 }] },
    { number: "RET-2026-00018", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 7, reason: "Verify batch before refund", customerName: "Tharindu Jay", amount: 1100, lines: [{ sku: "PCL-0004", qty: 1, unitPrice: 1100 }] },
    { number: "RET-2026-00019", type: GoodsReturnType.supplier, status: GoodsReturnStatus.in_review, daysAgo: 8, reason: "Awaiting supplier RMA confirmation", supplierId: supplier1.id, purchaseOrderId: poReceived.id, amount: 2800, lines: [{ sku: "PCL-0012", qty: 7, unitPrice: 400 }] },
    { number: "RET-2026-00020", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 11, reason: "Cold-chain product inspection", customerName: "Clinic walk-in", amount: 1950, lines: [{ sku: "PCL-0015", qty: 3, unitPrice: 650 }] },
    { number: "RET-2026-00021", type: GoodsReturnType.supplier, status: GoodsReturnStatus.in_review, daysAgo: 12, reason: "Credit note pending", supplierId: supplier2.id, amount: 900, lines: [{ sku: "PCL-0008", qty: 3, unitPrice: 300 }] },
    { number: "RET-2026-00022", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 3, reason: "Photo evidence under review", customerName: "Ishara Fonseka", amount: 430, lines: [{ sku: "PCL-0010", qty: 2, unitPrice: 215 }] },
    // Linked to INV-SEED-0001 (Paracetamol ×2 + Ibuprofen ×1)
    { number: "RET-2026-00023", type: GoodsReturnType.customer, status: GoodsReturnStatus.completed, daysAgo: 20, reason: "Unused sealed pack", customerName: "Gayani Silva", saleId: saleInv0001?.id ?? null, amount: 110, lines: [{ sku: "PCL-0001", qty: 2, unitPrice: 55 }] },
    { number: "RET-2026-00024", type: GoodsReturnType.customer, status: GoodsReturnStatus.completed, daysAgo: 25, reason: "Refund processed at counter", customerName: "Counter refund", saleId: saleInv0001?.id ?? null, amount: 38, lines: [{ sku: "PCL-0009", qty: 1, unitPrice: 38 }] },
    { number: "RET-2026-00025", type: GoodsReturnType.supplier, status: GoodsReturnStatus.completed, daysAgo: 28, reason: "Supplier credit received", supplierId: supplier1.id, amount: 4200, lines: [{ sku: "PCL-0007", qty: 10, unitPrice: 420 }] },
    // Linked to INV-SEED-0002 (Metformin ×3)
    { number: "RET-2026-00026", type: GoodsReturnType.customer, status: GoodsReturnStatus.completed, daysAgo: 15, reason: "Exchange completed", customerName: "Nimali Ratnayake", saleId: saleInv0002?.id ?? null, amount: 56, lines: [{ sku: "PCL-0003", qty: 2, unitPrice: 28 }] },
    { number: "RET-2026-00027", type: GoodsReturnType.supplier, status: GoodsReturnStatus.completed, daysAgo: 18, reason: "Damaged carton credited", supplierId: supplier2.id, amount: 1600, lines: [{ sku: "PCL-0019", qty: 4, unitPrice: 400 }] },
    { number: "RET-2026-00028", type: GoodsReturnType.customer, status: GoodsReturnStatus.rejected, daysAgo: 9, reason: "Opened pack — policy decline", customerName: "Opened pack claim", amount: 890, lines: [{ sku: "PCL-0006", qty: 1, unitPrice: 890 }], notes: "Rejected — seal broken" },
    { number: "RET-2026-00029", type: GoodsReturnType.supplier, status: GoodsReturnStatus.rejected, daysAgo: 14, reason: "Outside return window", supplierId: supplier1.id, amount: 3000, lines: [{ sku: "PCL-0027", qty: 5, unitPrice: 600 }] },
    { number: "RET-2026-00030", type: GoodsReturnType.customer, status: GoodsReturnStatus.rejected, daysAgo: 16, reason: "No proof of purchase", customerName: "Unknown walk-in", amount: 210, lines: [{ sku: "PCL-0022", qty: 1, unitPrice: 210 }] },
    { number: "RET-2026-00031", type: GoodsReturnType.customer, status: GoodsReturnStatus.cancelled, daysAgo: 3, reason: "Customer withdrew claim", customerName: "Cancelled walk-in", amount: 110, lines: [{ sku: "PCL-0001", qty: 2, unitPrice: 55 }], notes: "Cancelled before approval" },
    { number: "RET-2026-00032", type: GoodsReturnType.supplier, status: GoodsReturnStatus.cancelled, daysAgo: 5, reason: "Supplier RMA withdrawn", supplierId: supplier2.id, amount: 900, lines: [{ sku: "PCL-0012", qty: 3, unitPrice: 300 }] },
    // BRANCH2 returns
    { number: "RET-2026-KDY-01", type: GoodsReturnType.customer, status: GoodsReturnStatus.draft, daysAgo: 1, reason: "Wrong branch pickup", customerName: "Kandy walk-in", branchId: secondBranch.id, amount: 110, lines: [{ sku: "PCL-0001", qty: 2, unitPrice: 55 }] },
    { number: "RET-2026-KDY-02", type: GoodsReturnType.customer, status: GoodsReturnStatus.pending_approval, daysAgo: 2, reason: "Sealed return at counter", customerName: "Kandy customer", branchId: secondBranch.id, amount: 76, lines: [{ sku: "PCL-0009", qty: 2, unitPrice: 38 }] },
    { number: "RET-2026-KDY-03", type: GoodsReturnType.customer, status: GoodsReturnStatus.completed, daysAgo: 8, reason: "Completed Kandy refund", customerName: "Kandy refund", branchId: secondBranch.id, amount: 56, lines: [{ sku: "PCL-0003", qty: 2, unitPrice: 28 }] },
    { number: "RET-2026-KDY-04", type: GoodsReturnType.supplier, status: GoodsReturnStatus.in_review, daysAgo: 4, reason: "Branch overstock to supplier", supplierId: supplier1.id, branchId: secondBranch.id, amount: 500, lines: [{ sku: "PCL-0027", qty: 2, unitPrice: 250 }] },
  ];

  for (const def of returnDefs) {
    const branchId = def.branchId ?? mainBranch.id;
    const batchPrefix = branchId === secondBranch.id ? "BRANCH2" : "MAIN";
    const itemsData = def.lines
      .map((line) => {
        const ref = batchByKey.get(`${batchPrefix}:${line.sku}`);
        if (!ref) return null;
        return {
          tenantId: tenant.id,
          productId: productBySku.get(line.sku)!,
          batchId: ref.batchId,
          qty: line.qty,
          unitPrice: dec(line.unitPrice),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null);

    if (itemsData.length === 0) continue;

    const approved =
      def.status !== GoodsReturnStatus.draft &&
      def.status !== GoodsReturnStatus.pending_approval &&
      def.status !== GoodsReturnStatus.rejected &&
      def.status !== GoodsReturnStatus.cancelled;
    const processed =
      def.status === GoodsReturnStatus.in_review ||
      def.status === GoodsReturnStatus.completed;

    const created = await prisma.goodsReturn.create({
      data: {
        tenantId: tenant.id,
        branchId,
        returnNumber: def.number,
        type: def.type,
        status: def.status,
        customerName: def.customerName ?? null,
        supplierId: def.supplierId ?? null,
        saleId: def.saleId ?? null,
        purchaseOrderId: def.purchaseOrderId ?? null,
        reason: def.reason,
        notes: def.notes ?? null,
        amount: dec(def.amount),
        requestedBy: def.type === GoodsReturnType.customer ? cashier.id : inventoryClerk.id,
        approvedBy: approved || def.status === GoodsReturnStatus.rejected ? manager.id : null,
        processedBy: processed ? manager.id : null,
        createdAt: daysAgo(def.daysAgo),
        updatedAt: daysAgo(Math.max(0, def.daysAgo - 1)),
        items: { create: itemsData },
      },
      include: { items: true },
    });

    if (def.status === GoodsReturnStatus.completed) {
      for (const item of created.items) {
        if (!item.batchId) continue;
        if (def.type === GoodsReturnType.customer) {
          await prisma.stockLedger.create({
            data: {
              tenantId: tenant.id,
              branchId,
              productId: item.productId,
              batchId: item.batchId,
              movementType: StockMovementType.customer_return_in,
              qtyDelta: item.qty,
              referenceType: "goods_return",
              referenceId: created.id,
              reason: def.reason,
              createdBy: manager.id,
              occurredAt: daysAgo(Math.max(0, def.daysAgo - 2)),
            },
          });
        } else {
          await prisma.stockLedger.create({
            data: {
              tenantId: tenant.id,
              branchId,
              productId: item.productId,
              batchId: item.batchId,
              movementType: StockMovementType.supplier_return_out,
              qtyDelta: -item.qty,
              referenceType: "goods_return",
              referenceId: created.id,
              reason: def.reason,
              createdBy: manager.id,
              occurredAt: daysAgo(Math.max(0, def.daysAgo - 2)),
            },
          });
        }
      }
    }
  }

  // Draft stocktake on MAIN with a few systemQty lines from ledger
  const stocktakeSkus = ["PCL-0001", "PCL-0005", "PCL-0009", "PCL-0018"];
  const stocktakeLines: Array<{
    productId: string;
    batchId: string;
    systemQty: number;
  }> = [];
  for (const sku of stocktakeSkus) {
    const ref = batchByKey.get(`MAIN:${sku}`);
    if (!ref) continue;
    const agg = await prisma.stockLedger.aggregate({
      where: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        batchId: ref.batchId,
      },
      _sum: { qtyDelta: true },
    });
    stocktakeLines.push({
      productId: ref.productId,
      batchId: ref.batchId,
      systemQty: agg._sum.qtyDelta ?? 0,
    });
  }
  if (stocktakeLines.length > 0) {
    await prisma.stocktake.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        stocktakeNumber: "ST-SEED-001",
        status: StocktakeStatus.draft,
        scope: StocktakeScope.cycle,
        blindCount: false,
        notes: "Cycle count — demo draft (count a few lines, then Start)",
        countedBy: inventoryClerk.id,
        lines: {
          create: stocktakeLines.map((line) => ({
            tenantId: tenant.id,
            productId: line.productId,
            batchId: line.batchId,
            systemQty: line.systemQty,
          })),
        },
      },
    });
  }

  // In-progress blind near-expiry stocktake with partial counts + variance note
  const nearBatch = await prisma.batch.findFirst({
    where: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      batchNo: { contains: "NEAR" },
      isQuarantined: false,
    },
    orderBy: { expiryDate: "asc" },
  });
  if (nearBatch) {
    const nearQty =
      (
        await prisma.stockLedger.aggregate({
          where: {
            tenantId: tenant.id,
            branchId: mainBranch.id,
            batchId: nearBatch.id,
          },
          _sum: { qtyDelta: true },
        })
      )._sum.qtyDelta ?? 0;

    const extraNear = await prisma.batch.findMany({
      where: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        batchNo: { contains: "NEAR" },
        id: { not: nearBatch.id },
      },
      take: 3,
    });

    const nearLines: Array<{
      productId: string;
      batchId: string;
      systemQty: number;
      countedQty?: number;
      varianceQty?: number;
      note?: string;
    }> = [
      {
        productId: nearBatch.productId,
        batchId: nearBatch.id,
        systemQty: nearQty,
        countedQty: Math.max(0, nearQty - 2),
        varianceQty: -2,
        note: "Two packs damaged during count",
      },
    ];

    for (const b of extraNear) {
      const qty =
        (
          await prisma.stockLedger.aggregate({
            where: {
              tenantId: tenant.id,
              branchId: mainBranch.id,
              batchId: b.id,
            },
            _sum: { qtyDelta: true },
          })
        )._sum.qtyDelta ?? 0;
      nearLines.push({
        productId: b.productId,
        batchId: b.id,
        systemQty: qty,
      });
    }

    await prisma.stocktake.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        stocktakeNumber: "ST-SEED-002",
        status: StocktakeStatus.counting,
        scope: StocktakeScope.near_expiry,
        blindCount: true,
        nearExpiryDays: 30,
        frozenAt: daysAgo(0),
        notes: "Blind near-expiry count — finish remaining lines then Complete",
        countedBy: inventoryClerk.id,
        createdAt: daysAgo(1),
        lines: {
          create: nearLines.map((line) => ({
            tenantId: tenant.id,
            productId: line.productId,
            batchId: line.batchId,
            systemQty: line.systemQty,
            countedQty: line.countedQty ?? null,
            varianceQty: line.varianceQty ?? null,
            note: line.note ?? null,
            countedAt: line.countedQty != null ? daysAgo(0) : null,
          })),
        },
      },
    });
  }

  // Completed full stocktake with posted variance ledger
  const completedSku = "PCL-0002";
  const completedRef = batchByKey.get(`MAIN:${completedSku}`);
  if (completedRef) {
    const sysQty =
      (
        await prisma.stockLedger.aggregate({
          where: {
            tenantId: tenant.id,
            branchId: mainBranch.id,
            batchId: completedRef.batchId,
          },
          _sum: { qtyDelta: true },
        })
      )._sum.qtyDelta ?? 0;
    const counted = sysQty; // zero variance demo line
    const stCompleted = await prisma.stocktake.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        stocktakeNumber: "ST-SEED-003",
        status: StocktakeStatus.completed,
        scope: StocktakeScope.full,
        blindCount: false,
        frozenAt: daysAgo(12),
        notes: "Completed full count — matched",
        countedBy: inventoryClerk.id,
        completedBy: manager.id,
        completedAt: daysAgo(12),
        createdAt: daysAgo(13),
        lines: {
          create: [
            {
              tenantId: tenant.id,
              productId: completedRef.productId,
              batchId: completedRef.batchId,
              systemQty: sysQty,
              countedQty: counted,
              varianceQty: 0,
              note: "Matched to system",
              countedAt: daysAgo(12),
            },
          ],
        },
      },
    });
    void stCompleted;
  }

  // Document sequences — keep runtime next numbers above seed + ops PO-/GRN-/TR-/ST- values
  for (const branch of allBranches) {
    for (const docType of ["po", "grn", "stocktake"] as const) {
      await prisma.documentSequence.upsert({
        where: {
          tenantId_branchId_docType: {
            tenantId: tenant.id,
            branchId: branch.id,
            docType,
          },
        },
        update: { nextValue: 500 },
        create: {
          tenantId: tenant.id,
          branchId: branch.id,
          docType,
          nextValue: 500,
        },
      });
    }
  }
  await prisma.documentSequence.upsert({
    where: {
      tenantId_branchId_docType: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        docType: "tenant:transfer",
      },
    },
    update: { nextValue: 500 },
    create: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      docType: "tenant:transfer",
      nextValue: 500,
    },
  });

  // Demo account customers (for credit / receivables)
  const demoCustomerDefs = [
    { fullName: "Saman Perera", phone: "0771234501" },
    { fullName: "Nadeesha Fernando", phone: "0771234502" },
    { fullName: "Kamani Jayasuriya", phone: "0771234503" },
    { fullName: "Ruwan Silva", phone: "0771234504" },
    { fullName: "Priya Wickramasinghe", phone: "0771234505" },
    { fullName: "Ashan Mendis", phone: "0771234506" },
    { fullName: "Fathima Rizwan", phone: "0771234507" },
    { fullName: "Dilani Gunasekara", phone: "0771234508" },
    { fullName: "Heshan Bandara", phone: "0771234509" },
    { fullName: "Malsha Perera", phone: "0771234510" },
    { fullName: "Tharindu Jayasinghe", phone: "0771234511" },
    { fullName: "Ishara Fonseka", phone: "0771234512" },
    { fullName: "Gayani Silva", phone: "0771234513" },
    { fullName: "Nimali Ratnayake", phone: "0771234514" },
    { fullName: "Chaminda Weerasinghe", phone: "0771234515" },
    { fullName: "Sanduni Perera", phone: "0771234516" },
    { fullName: "Kasun Abeywardena", phone: "0771234517" },
    { fullName: "Amaya Dias", phone: "0771234518" },
    { fullName: "Roshan Fernando", phone: "0771234519" },
    { fullName: "Shanika Wijesinghe", phone: "0771234520" },
    { fullName: "Nuwan Kariyawasam", phone: "0771234521" },
    { fullName: "Lakmini Jayawardena", phone: "0771234522" },
    { fullName: "Imran Mohamed", phone: "0771234523" },
  ];
  const customerIds: string[] = [];
  for (const c of demoCustomerDefs) {
    const row = await prisma.customer.upsert({
      where: { tenantId_phone: { tenantId: tenant.id, phone: c.phone } },
      update: { fullName: c.fullName, isActive: true },
      create: {
        tenantId: tenant.id,
        fullName: c.fullName,
        phone: c.phone,
      },
    });
    customerIds.push(row.id);
  }

  // Bulk ~90-day multi-branch history for dashboards / analytics (after scenario fixtures).
  const activeSupplierIds = [
    "SUP-001",
    "SUP-002",
    "SUP-003",
    "SUP-005",
    "SUP-006",
    "SUP-008",
    "SUP-011",
  ]
    .map((code) => supplierByCode.get(code))
    .filter((id): id is string => Boolean(id));

  const demoOps = await seedDemoOps(prisma, {
    tenantId: tenant.id,
    branches: [
      { id: mainBranch.id, code: "MAIN", salesWeight: 0.42 },
      { id: secondBranch.id, code: "BRANCH2", salesWeight: 0.28 },
      { id: galleBranch.id, code: "GALLE", salesWeight: 0.18 },
      { id: negomboBranch.id, code: "NEGOMBO", salesWeight: 0.12 },
    ],
    users: {
      cashierId: cashier.id,
      managerId: manager.id,
      pharmacistId: pharmacist.id,
      clerkId: inventoryClerk.id,
      cashiersByBranch: {
        [mainBranch.id]: mainCashiers.map((u) => u.id),
        [secondBranch.id]: branch2Cashiers.map((u) => u.id),
      },
    },
    productBySku,
    nmraProducts: nmra.products,
    demoStockRegNos: nmra.demoStockRegNos,
    supplierIds: activeSupplierIds,
    customerIds,
  });

  // ── Retail demo catalog (non-Medicines departments) ──────────────────────
  // Must run AFTER seedDemoOps: seedDemoOps moves every product outside its curated Medicines
  // "sellable" set into the reference catalog before ranging that set, so running this earlier
  // would leave every RTL- product un-ranged. Layered on top here, it's untouched by that sweep
  // (new products default to RANGED) and adds
  // Vitamins & Supplements / Baby Care / Personal Care / Beauty / Medical Devices / First Aid /
  // Nutrition / Food & Beverage / Household — so Reports → Profitability and Inventory show a
  // real, department-weighted revenue mix instead of Medicines-only data.
  console.log("\nSeeding retail demo catalog (non-Medicines departments)…");
  await seedRetailDemoProducts(prisma, tenant.id, tenant.code);
  await seedRetailDemoSales(prisma, tenant.id, tenant.code);

  // ── Held sales (Pharmacist "Prescription Verification Queue" demo data) ──
  console.log("Seeding held sales (Prescription Verification Queue demo data)…");
  const heldSaleDefs: Array<{
    branch: { id: string };
    holdRef: string;
    label: string | null;
    heldBy: string;
    minutesAgo: number;
    needsPharmacist: boolean;
    lines: Array<{ sku: string; qty: number; unitPrice: number }>;
  }> = [
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-01",
      label: null,
      heldBy: mainCashiers[0]!.id,
      minutesAgo: 35,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0021", qty: 1, unitPrice: 620 }],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-02",
      label: "Mr. Perera",
      heldBy: cashier.id,
      minutesAgo: 62,
      needsPharmacist: true,
      lines: [
        { sku: "PCL-0026", qty: 1, unitPrice: 1580 },
        { sku: "PCL-0001", qty: 2, unitPrice: 55 },
      ],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-03",
      label: "Blue shirt",
      heldBy: mainCashiers[1]!.id,
      minutesAgo: 8,
      needsPharmacist: false,
      lines: [
        { sku: "PCL-0002", qty: 1, unitPrice: 165 },
        { sku: "PCL-0005", qty: 2, unitPrice: 22 },
      ],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-04",
      label: "Mrs. Jayasuriya",
      heldBy: mainCashiers[0]!.id,
      minutesAgo: 3,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0003", qty: 1, unitPrice: 28 }],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-05",
      label: null,
      heldBy: cashier.id,
      minutesAgo: 6,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0004", qty: 2, unitPrice: 72 }],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-06",
      label: "Mr. Fernando",
      heldBy: mainCashiers[1]!.id,
      minutesAgo: 14,
      needsPharmacist: true,
      lines: [
        { sku: "PCL-0006", qty: 1, unitPrice: 115 },
        { sku: "PCL-0008", qty: 1, unitPrice: 32 },
      ],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-07",
      label: "Mrs. Rathnayake",
      heldBy: mainCashiers[0]!.id,
      minutesAgo: 22,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0010", qty: 1, unitPrice: 285 }],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-08",
      label: null,
      heldBy: cashier.id,
      minutesAgo: 27,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0012", qty: 2, unitPrice: 45 }],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-09",
      label: "Mr. Wickramasinghe",
      heldBy: mainCashiers[1]!.id,
      minutesAgo: 45,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0013", qty: 1, unitPrice: 130 }],
    },
    {
      branch: mainBranch,
      holdRef: "HOLD-SEED-10",
      label: "Mrs. Kumarasiri",
      heldBy: mainCashiers[0]!.id,
      minutesAgo: 90,
      needsPharmacist: true,
      lines: [
        { sku: "PCL-0016", qty: 1, unitPrice: 85 },
        { sku: "PCL-0019", qty: 1, unitPrice: 125 },
      ],
    },
    {
      branch: secondBranch,
      holdRef: "HOLD-SEED-01",
      label: null,
      heldBy: branch2Cashiers[0]!.id,
      minutesAgo: 20,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0009", qty: 1, unitPrice: 38 }],
    },
    {
      branch: secondBranch,
      holdRef: "HOLD-SEED-02",
      label: "Mrs. Bandara",
      heldBy: branch2Cashiers[1]!.id,
      minutesAgo: 47,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0027", qty: 1, unitPrice: 250 }],
    },
    {
      branch: galleBranch,
      holdRef: "HOLD-SEED-01",
      label: null,
      heldBy: cashier.id,
      minutesAgo: 15,
      needsPharmacist: true,
      lines: [{ sku: "PCL-0001", qty: 3, unitPrice: 55 }],
    },
  ];

  // Recall only restores lines whose batchId still resolves to a real batch
  // (see pos/page.tsx recallHold) — held sales need a real batchId per line,
  // not just a productId, or every recall drops every line as "not sellable".
  const heldSaleBatchByKey = new Map<string, string>();
  for (const def of heldSaleDefs) {
    for (const l of def.lines) {
      const productId = productBySku.get(l.sku);
      if (!productId) continue;
      const key = `${def.branch.id}:${productId}`;
      if (heldSaleBatchByKey.has(key)) continue;
      const batch = await prisma.batch.findFirst({
        where: { tenantId: tenant.id, branchId: def.branch.id, productId },
        orderBy: { receivedAt: "desc" },
        select: { id: true },
      });
      if (batch) heldSaleBatchByKey.set(key, batch.id);
    }
  }

  for (const def of heldSaleDefs) {
    const createdAt = new Date(Date.now() - def.minutesAgo * 60_000);
    // Mirror the real park-cart payload shape (apps/web pos/types.ts CartLine) —
    // the POS recall screen resolves totals from these fields directly, so a
    // held sale missing key/discountPercent/addedAt silently prices at 0.
    const lines = def.lines.map((l, i) => {
      const productId = productBySku.get(l.sku) ?? null;
      const batchId = productId ? (heldSaleBatchByKey.get(`${def.branch.id}:${productId}`) ?? null) : null;
      return {
        key: `${productId}:${batchId}`,
        productId,
        batchId,
        sku: l.sku,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPercent: 0,
        addedAt: createdAt.getTime() + i,
      };
    });
    const total = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
    const itemCount = def.lines.reduce((sum, l) => sum + l.qty, 0);
    await prisma.heldSale.create({
      data: {
        tenantId: tenant.id,
        branchId: def.branch.id,
        holdRef: def.holdRef,
        label: def.label,
        itemCount,
        total: dec(total),
        payload: {
          lines,
          meta: {
            needsPharmacist: def.needsPharmacist,
            holdReason: def.needsPharmacist ? "awaiting_pharmacist" : null,
          },
        } as Prisma.InputJsonValue,
        heldBy: def.heldBy,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
  console.log(
    `  Held sales: ${heldSaleDefs.length} (${heldSaleDefs.filter((d) => d.needsPharmacist).length} awaiting pharmacist)`,
  );

  // Monthly branch sales targets for last 8 calendar months (Owner-set → manager) — matches the
  // ~8-month window seed-demo-ops/seed-retail-demo-sales generate daily sales history for.
  const nowYm = new Date();
  let targetsSeeded = 0;
  for (let monthsAgo = 7; monthsAgo >= 0; monthsAgo--) {
    const cursor = new Date(nowYm.getFullYear(), nowYm.getMonth() - monthsAgo, 1);
    const yearMonth = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const isCurrentMonth = monthsAgo === 0;
    const dayOfMonth = Math.max(nowYm.getDate(), 1);
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

    for (const branch of allBranches) {
      const agg = await prisma.sale.aggregate({
        where: {
          tenantId: tenant.id,
          branchId: branch.id,
          soldAt: { gte: monthStart, lt: monthEnd },
          status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
        },
        _sum: { grandTotal: true },
      });
      const monthSales = Number(agg._sum.grandTotal ?? 0);
      const fallback =
        branch.code === "MAIN"
          ? 320_000
          : branch.code === "BRANCH2"
            ? 210_000
            : branch.code === "GALLE"
              ? 140_000
              : 95_000;
      const base =
        monthSales > 0
          ? isCurrentMonth
            ? (monthSales / dayOfMonth) * daysInMonth
            : monthSales
          : fallback;
      // Slight stretch so achievement lands ~80–95% for demo realism
      const stretch = isCurrentMonth ? 1.08 : 1.05;
      const targetAmount = Math.round(base * stretch);

      const branchManagerId = managerIdByBranch.get(branch.id) ?? manager.id;
      await prisma.branchMonthlyTarget.upsert({
        where: {
          tenantId_branchId_yearMonth: {
            tenantId: tenant.id,
            branchId: branch.id,
            yearMonth,
          },
        },
        create: {
          tenantId: tenant.id,
          branchId: branch.id,
          yearMonth,
          targetAmount: dec(targetAmount),
          managerUserId: branchManagerId,
          notes: "Seed monthly sales target",
          createdBy: owner.id,
        },
        update: {
          targetAmount: dec(targetAmount),
          managerUserId: branchManagerId,
          notes: "Seed monthly sales target",
        },
      });
      targetsSeeded++;
    }
  }
  const returnCount = await prisma.goodsReturn.count({ where: { tenantId: tenant.id } });

  const batchCount = await prisma.batch.count({ where: { tenantId: tenant.id } });
  const ledgerCount = await prisma.stockLedger.count({ where: { tenantId: tenant.id } });
  const poCount = await prisma.purchaseOrder.count({ where: { tenantId: tenant.id } });
  const transferCount = await prisma.transfer.count({ where: { tenantId: tenant.id } });
  const stocktakeCount = await prisma.stocktake.count({ where: { tenantId: tenant.id } });
  const totalSales = await prisma.sale.count({ where: { tenantId: tenant.id } });
  const paymentCount = await prisma.salePayment.count({ where: { tenantId: tenant.id } });
  const activeProductCount = await prisma.product.count({
    where: { tenantId: tenant.id, isActive: true },
  });

  await ensureRbacSeed(prisma);

  console.log("\n=== PharmaCeylon demo seed complete ===\n");
  console.log(`Tenant:     ${TENANT_CODE} (${tenant.displayName})`);
  console.log(
    `Branches:   ${allBranches.map((b) => `${b.code} (${b.name})`).join(", ")}`,
  );
  console.log(`Products:   ${nmra.products.length} NMRA catalog (${activeProductCount} active / sellable)`);
  console.log(`Brands:     ${nmra.brandCount} distinct brand names`);
  console.log(`Categories: ${nmra.categoryCount} (dosage form / schedule / reg type)`);
  console.log(`Batches:    ${batchCount}`);
  console.log(`Ledger:     ${ledgerCount} movements`);
  console.log(
    `Sales:      ${totalSales} invoices (scenario ${saleCount} + ops ${demoOps.sales}; payments ${paymentCount})`,
  );
  console.log(`POs:        ${poCount} (includes ${demoOps.purchaseOrders} ops replenishment)`);
  console.log(`GRNs:       ${demoOps.goodsReceipts} ops receipts (+ scenario GRNs)`);
  console.log(`Transfers:  ${transferCount} (includes ${demoOps.transfers} ops)`);
  console.log(
    `Returns:    ${returnCount} (includes ${demoOps.customerReturns} ops customer returns)`,
  );
  console.log(`Stocktakes: ${stocktakeCount} (draft, in progress, completed)`);
  console.log(
    `Ops extras: barcodes+${demoOps.barcodesAdded}, near-expiry batches ${demoOps.nearExpiryBatches}, secondary stock lots ${demoOps.branchBatches}`,
  );
  console.log(
    `Targets:    ${targetsSeeded} branch-month rows (last 8 months, assigned to manager)`,
  );
  console.log(
    `Daily sales history: ~${demoOps.sales} ops invoices across ~8 months, plus retail sales across every non-Medicines department`,
  );
  console.log("\nLogins (passwords from SEED_*_PASSWORD or defaults):");
  console.log("  owner@pharmaceylon.demo      — owner");
  console.log("  manager@pharmaceylon.demo    — manager (MAIN + BRANCH2)");
  console.log("  manager2@pharmaceylon.demo   — manager (GALLE + NEGOMBO)");
  console.log("  pharmacist@pharmaceylon.demo — pharmacist (till PIN from SEED_PHARMACIST_POS_PIN or 1234)");
  console.log("  cashier@pharmaceylon.demo    — cashier");
  console.log("  clerk@pharmaceylon.demo      — inventory_clerk");
  console.log("\nDefaults: Owner123! / Manager123! / Pharmacist123! / Cashier123! / Clerk123!");
  console.log("(Legacy admin@pharmaceylon.demo is deactivated — use owner@ for business ownership.)");
  console.log("\nTip: select MAIN branch in the app header to see stock, batches, and low-stock filters.\n");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
