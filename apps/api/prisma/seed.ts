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
  await prisma.goodsReturn.deleteMany({ where: { tenantId } });
  await prisma.sale.deleteMany({ where: { tenantId } });
  await prisma.goodsReceipt.deleteMany({ where: { tenantId } });
  await prisma.stockLedger.deleteMany({ where: { tenantId } });
  await prisma.transfer.deleteMany({ where: { tenantId } });
  await prisma.batch.deleteMany({ where: { tenantId } });
  await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
  await prisma.auditEvent.deleteMany({ where: { tenantId } });
  await prisma.productAlias.deleteMany({ where: { tenantId } });
  await prisma.productTagMap.deleteMany({ where: { tenantId } });
  await prisma.productCategoryMap.deleteMany({ where: { tenantId } });
  await prisma.productSimilarity.deleteMany({ where: { tenantId } });
}

const PRODUCT_SPEC_DEFAULTS: Record<
  string,
  { packSize: string; storage: string; shelfLife: string; taxCategory: string }
> = {
  Tablet: {
    packSize: "10 tablets",
    storage: "Store below 30°C in a dry place",
    shelfLife: "36 months",
    taxCategory: "Standard rate",
  },
  Capsule: {
    packSize: "10 capsules",
    storage: "Store below 30°C in a dry place",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
  "Soft Capsule": {
    packSize: "30 soft capsules",
    storage: "Store below 25°C, protect from light",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
  Inhaler: {
    packSize: "1 inhaler (200 doses)",
    storage: "Store below 25°C, do not freeze",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
  Gel: {
    packSize: "30 g tube",
    storage: "Store below 25°C",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
  Cream: {
    packSize: "15 g tube",
    storage: "Store below 25°C",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
  Solution: {
    packSize: "100 mL bottle",
    storage: "Store below 25°C, protect from light",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
  Injection: {
    packSize: "1 vial",
    storage: "Refrigerate at 2–8°C, do not freeze",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
};

const PRODUCT_SPEC_OVERRIDES: Record<
  string,
  Partial<{ packSize: string; storage: string; shelfLife: string; taxCategory: string }>
> = {
  "PCL-0008": {
    packSize: "30 tablets",
    storage: "Store below 25°C in a dry place",
    shelfLife: "24 months",
    taxCategory: "Standard rate",
  },
};

type ProductSeed = {
  sku: string;
  barcode?: string;
  name: string;
  genericName?: string | null;
  brandName?: string | null;
  manufacturer?: string | null;
  dosageForm?: string | null;
  strength?: string | null;
  unit?: string | null;
  isControlled?: boolean;
  reorderLevel?: number;
  isActive?: boolean;
};

function resolveProductSpecs(product: ProductSeed) {
  const defaults =
    PRODUCT_SPEC_DEFAULTS[product.dosageForm ?? "Tablet"] ?? PRODUCT_SPEC_DEFAULTS.Tablet;
  const overrides = PRODUCT_SPEC_OVERRIDES[product.sku] ?? {};
  return { ...defaults, ...overrides };
}

const PRODUCTS: ProductSeed[] = [
  { sku: "PCL-0001", barcode: "4790012345671", name: "Paracetamol 500mg Tablets", genericName: "Paracetamol", brandName: "Panadol", manufacturer: "GlaxoSmithKline", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 50 },
  { sku: "PCL-0002", barcode: "4790012345672", name: "Amoxicillin 500mg Capsules", genericName: "Amoxicillin", brandName: "Amoxil", manufacturer: "Pfizer", dosageForm: "Capsule", strength: "500mg", unit: "strip", reorderLevel: 30 },
  { sku: "PCL-0003", barcode: "4790012345673", name: "Metformin 500mg Tablets", genericName: "Metformin HCl", brandName: "Glucophage", manufacturer: "Merck", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 40 },
  { sku: "PCL-0004", barcode: "4790012345674", name: "Omeprazole 20mg Capsules", genericName: "Omeprazole", brandName: "Losec", manufacturer: "AstraZeneca", dosageForm: "Capsule", strength: "20mg", unit: "strip", reorderLevel: 25 },
  { sku: "PCL-0005", barcode: "4790012345675", name: "Cetirizine 10mg Tablets", genericName: "Cetirizine HCl", brandName: "Zyrtec", manufacturer: "UCB Pharma", dosageForm: "Tablet", strength: "10mg", unit: "strip", reorderLevel: 20 },
  { sku: "PCL-0006", barcode: "4790012345676", name: "Atorvastatin 20mg Tablets", genericName: "Atorvastatin Calcium", brandName: "Lipitor", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "20mg", unit: "strip", reorderLevel: 15 },
  { sku: "PCL-0007", barcode: "4790012345677", name: "Losartan 50mg Tablets", genericName: "Losartan Potassium", brandName: "Cozaar", manufacturer: "Merck", dosageForm: "Tablet", strength: "50mg", unit: "strip", reorderLevel: 20 },
  { sku: "PCL-0008", barcode: "4790012345678", name: "Amlodipine 5mg Tablets", genericName: "Amlodipine Besylate", brandName: "Norvasc", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "5mg", unit: "strip", reorderLevel: 25 },
  { sku: "PCL-0009", barcode: "4790012345679", name: "Ibuprofen 400mg Tablets", genericName: "Ibuprofen", brandName: "Brufen", manufacturer: "Abbott", dosageForm: "Tablet", strength: "400mg", unit: "strip", reorderLevel: 35 },
  { sku: "PCL-0010", barcode: "4790012345680", name: "Azithromycin 500mg Tablets", genericName: "Azithromycin", brandName: "Zithromax", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 15 },
  { sku: "PCL-0011", barcode: "4790012345681", name: "Salbutamol Inhaler 100mcg", genericName: "Salbutamol", brandName: "Ventolin", manufacturer: "GlaxoSmithKline", dosageForm: "Inhaler", strength: "100mcg", unit: "piece", reorderLevel: 10 },
  { sku: "PCL-0012", barcode: "4790012345682", name: "Metoprolol 50mg Tablets", genericName: "Metoprolol Tartrate", brandName: "Lopressor", manufacturer: "Novartis", dosageForm: "Tablet", strength: "50mg", unit: "strip", reorderLevel: 20 },
  { sku: "PCL-0013", barcode: "4790012345683", name: "Diclofenac Sodium Gel 1%", genericName: "Diclofenac Sodium", brandName: "Voltaren", manufacturer: "Novartis", dosageForm: "Gel", strength: "1%", unit: "tube", reorderLevel: 15 },
  { sku: "PCL-0014", barcode: "4790012345684", name: "Clopidogrel 75mg Tablets", genericName: "Clopidogrel", brandName: "Plavix", manufacturer: "Sanofi", dosageForm: "Tablet", strength: "75mg", unit: "strip", reorderLevel: 10 },
  { sku: "PCL-0015", barcode: "4790012345685", name: "Pantoprazole 40mg Tablets", genericName: "Pantoprazole Sodium", brandName: "Protonix", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "40mg", unit: "strip", reorderLevel: 20 },
  { sku: "PCL-0016", barcode: "4790012345686", name: "Ciprofloxacin 500mg Tablets", genericName: "Ciprofloxacin HCl", brandName: "Cipro", manufacturer: "Bayer", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 15 },
  { sku: "PCL-0017", barcode: "4790012345687", name: "Levothyroxine 50mcg Tablets", genericName: "Levothyroxine Sodium", brandName: "Synthroid", manufacturer: "AbbVie", dosageForm: "Tablet", strength: "50mcg", unit: "strip", reorderLevel: 10 },
  { sku: "PCL-0018", barcode: "4790012345688", name: "Prednisolone 5mg Tablets", genericName: "Prednisolone", brandName: "Prelone", manufacturer: "Sanofi", dosageForm: "Tablet", strength: "5mg", unit: "strip", reorderLevel: 15 },
  { sku: "PCL-0019", barcode: "4790012345689", name: "Cephalexin 500mg Capsules", genericName: "Cephalexin", brandName: "Keflex", manufacturer: "Shionogi", dosageForm: "Capsule", strength: "500mg", unit: "strip", reorderLevel: 20 },
  { sku: "PCL-0020", barcode: "4790012345690", name: "Furosemide 40mg Tablets", genericName: "Furosemide", brandName: "Lasix", manufacturer: "Sanofi", dosageForm: "Tablet", strength: "40mg", unit: "strip", reorderLevel: 15 },
  { sku: "PCL-0021", barcode: "4790012345691", name: "Morphine Sulfate 10mg Tablets", genericName: "Morphine Sulfate", brandName: "MS Contin", manufacturer: "Purdue Pharma", dosageForm: "Tablet", strength: "10mg", unit: "strip", isControlled: true, reorderLevel: 5 },
  { sku: "PCL-0022", barcode: "4790012345692", name: "Diazepam 5mg Tablets", genericName: "Diazepam", brandName: "Valium", manufacturer: "Roche", dosageForm: "Tablet", strength: "5mg", unit: "strip", isControlled: true, reorderLevel: 5 },
  { sku: "PCL-0023", barcode: "4790012345693", name: "Codeine Phosphate 30mg Tablets", genericName: "Codeine Phosphate", brandName: "Codeine", manufacturer: "Johnson & Johnson", dosageForm: "Tablet", strength: "30mg", unit: "strip", isControlled: true, reorderLevel: 5 },
  { sku: "PCL-0024", barcode: "4790012345694", name: "Betadine Solution 10%", genericName: "Povidone Iodine", brandName: "Betadine", manufacturer: "Mundipharma", dosageForm: "Solution", strength: "10%", unit: "bottle", reorderLevel: 10 },
  { sku: "PCL-0025", barcode: "4790012345695", name: "Chlorhexidine Mouthwash", genericName: "Chlorhexidine Gluconate", brandName: "Savacol", manufacturer: "Colgate", dosageForm: "Solution", strength: "0.2%", unit: "bottle", reorderLevel: 8 },
  { sku: "PCL-0026", barcode: "4790012345696", name: "Insulin Glargine 100IU/mL", genericName: "Insulin Glargine", brandName: "Lantus", manufacturer: "Sanofi", dosageForm: "Injection", strength: "100IU/mL", unit: "vial", reorderLevel: 5 },
  { sku: "PCL-0027", barcode: "4790012345697", name: "Multivitamin Tablets", genericName: "Multivitamins", brandName: "Centrum", manufacturer: "Pfizer", dosageForm: "Tablet", strength: null, unit: "bottle", reorderLevel: 15 },
  { sku: "PCL-0028", barcode: "4790012345698", name: "Vitamin D3 1000IU Soft Capsules", genericName: "Cholecalciferol", brandName: "D-Cal", manufacturer: "Herbalife", dosageForm: "Soft Capsule", strength: "1000IU", unit: "bottle", reorderLevel: 10 },
  { sku: "PCL-0029", barcode: "4790012345699", name: "Ranitidine 150mg Tablets", genericName: "Ranitidine HCl", brandName: "Zantac", manufacturer: "GlaxoSmithKline", dosageForm: "Tablet", strength: "150mg", unit: "strip", reorderLevel: 20, isActive: false },
  { sku: "PCL-0030", barcode: "4790012345700", name: "Clotrimazole Cream 1%", genericName: "Clotrimazole", brandName: "Canesten", manufacturer: "Bayer", dosageForm: "Cream", strength: "1%", unit: "tube", reorderLevel: 10 },
];

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
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const cashierPassword = process.env.SEED_CASHIER_PASSWORD ?? "Cashier123!";
  const managerPassword = process.env.SEED_MANAGER_PASSWORD ?? "Manager123!";
  const pharmacistPassword = process.env.SEED_PHARMACIST_PASSWORD ?? "Pharmacist123!";
  const clerkPassword = process.env.SEED_CLERK_PASSWORD ?? "Clerk123!";

  for (const p of [adminPassword, cashierPassword, managerPassword, pharmacistPassword, clerkPassword]) {
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

  const [adminHash, cashierHash, managerHash, pharmacistHash, clerkHash] = await Promise.all([
    bcrypt.hash(adminPassword, 10),
    bcrypt.hash(cashierPassword, 10),
    bcrypt.hash(managerPassword, 10),
    bcrypt.hash(pharmacistPassword, 10),
    bcrypt.hash(clerkPassword, 10),
  ]);

  const admin = await prisma.appUser.upsert({
    where: { email: "admin@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Seed Administrator", isActive: true, passwordHash: adminHash },
    create: { tenantId: tenant.id, email: "admin@pharmaceylon.demo", fullName: "Seed Administrator", passwordHash: adminHash },
  });

  const manager = await prisma.appUser.upsert({
    where: { email: "manager@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Nimal Perera", isActive: true, passwordHash: managerHash },
    create: { tenantId: tenant.id, email: "manager@pharmaceylon.demo", fullName: "Nimal Perera", passwordHash: managerHash },
  });

  const pharmacist = await prisma.appUser.upsert({
    where: { email: "pharmacist@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Dr. Anjali Fernando", isActive: true, passwordHash: pharmacistHash },
    create: { tenantId: tenant.id, email: "pharmacist@pharmaceylon.demo", fullName: "Dr. Anjali Fernando", passwordHash: pharmacistHash },
  });

  const cashier = await prisma.appUser.upsert({
    where: { email: "cashier@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Seed Cashier", isActive: true, passwordHash: cashierHash },
    create: { tenantId: tenant.id, email: "cashier@pharmaceylon.demo", fullName: "Kamal Silva", passwordHash: cashierHash },
  });

  const inventoryClerk = await prisma.appUser.upsert({
    where: { email: "clerk@pharmaceylon.demo" },
    update: { tenantId: tenant.id, fullName: "Priya Jayawardena", isActive: true, passwordHash: clerkHash },
    create: { tenantId: tenant.id, email: "clerk@pharmaceylon.demo", fullName: "Priya Jayawardena", passwordHash: clerkHash },
  });

  await prisma.userBranchRole.deleteMany({
    where: { tenantId: tenant.id, userId: { in: [admin.id, manager.id, pharmacist.id, cashier.id, inventoryClerk.id] } },
  });

  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: tenant.id, userId: admin.id, branchId: mainBranch.id, role: RoleName.owner },
      { tenantId: tenant.id, userId: admin.id, branchId: secondBranch.id, role: RoleName.owner },
      { tenantId: tenant.id, userId: manager.id, branchId: mainBranch.id, role: RoleName.manager },
      { tenantId: tenant.id, userId: manager.id, branchId: secondBranch.id, role: RoleName.manager },
      { tenantId: tenant.id, userId: pharmacist.id, branchId: mainBranch.id, role: RoleName.pharmacist },
      { tenantId: tenant.id, userId: cashier.id, branchId: mainBranch.id, role: RoleName.cashier },
      { tenantId: tenant.id, userId: cashier.id, branchId: secondBranch.id, role: RoleName.cashier },
      { tenantId: tenant.id, userId: inventoryClerk.id, branchId: mainBranch.id, role: RoleName.inventory_clerk },
      { tenantId: tenant.id, userId: inventoryClerk.id, branchId: secondBranch.id, role: RoleName.inventory_clerk },
    ],
  });

  const productBySku = new Map<string, string>();
  for (const p of PRODUCTS) {
    const specs = resolveProductSpecs(p);
    const row = await prisma.product.upsert({
      where: { tenantId_sku: { tenantId: tenant.id, sku: p.sku } },
      update: {
        name: p.name,
        barcode: p.barcode ?? null,
        brandName: p.brandName ?? null,
        genericName: p.genericName ?? null,
        manufacturer: p.manufacturer ?? null,
        dosageForm: p.dosageForm ?? null,
        strength: p.strength ?? null,
        unit: p.unit ?? null,
        packSize: specs.packSize,
        storage: specs.storage,
        shelfLife: specs.shelfLife,
        taxCategory: specs.taxCategory,
        isControlled: p.isControlled ?? false,
        reorderLevel: p.reorderLevel ?? 0,
        isActive: (p as { isActive?: boolean }).isActive ?? true,
      },
      create: {
        tenantId: tenant.id,
        sku: p.sku,
        barcode: p.barcode ?? null,
        name: p.name,
        genericName: p.genericName ?? null,
        brandName: p.brandName ?? null,
        manufacturer: p.manufacturer ?? null,
        dosageForm: p.dosageForm ?? null,
        strength: p.strength ?? null,
        unit: p.unit ?? null,
        packSize: specs.packSize,
        storage: specs.storage,
        shelfLife: specs.shelfLife,
        taxCategory: specs.taxCategory,
        isControlled: p.isControlled ?? false,
        reorderLevel: p.reorderLevel ?? 0,
        isActive: (p as { isActive?: boolean }).isActive ?? true,
      },
    });
    productBySku.set(p.sku, row.id);
  }

  const supplier1 = await prisma.supplier.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SUP-001" } },
    update: { name: "Lanka Pharma Distributors" },
    create: { tenantId: tenant.id, code: "SUP-001", name: "Lanka Pharma Distributors", leadTimeDays: 3, paymentTermsDays: 30 },
  });

  const supplier2 = await prisma.supplier.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SUP-002" } },
    update: { name: "MediCare Imports (Pvt) Ltd" },
    create: { tenantId: tenant.id, code: "SUP-002", name: "MediCare Imports (Pvt) Ltd", leadTimeDays: 5, paymentTermsDays: 45 },
  });

  await prisma.supplier.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SUP-003" } },
    update: { name: "Colombo Medical Supplies" },
    create: { tenantId: tenant.id, code: "SUP-003", name: "Colombo Medical Supplies", leadTimeDays: 2, paymentTermsDays: 14 },
  });

  const categoryDefs = [
    { name: "Pain Relief", skus: ["PCL-0001", "PCL-0009", "PCL-0013"] },
    { name: "Antibiotics", skus: ["PCL-0002", "PCL-0010", "PCL-0016", "PCL-0019"] },
    { name: "Cardiovascular", skus: ["PCL-0006", "PCL-0007", "PCL-0008", "PCL-0012", "PCL-0014"] },
    { name: "Gastrointestinal", skus: ["PCL-0004", "PCL-0015"] },
    { name: "Controlled Substances", skus: ["PCL-0021", "PCL-0022", "PCL-0023"] },
    { name: "OTC & Wellness", skus: ["PCL-0024", "PCL-0025", "PCL-0027", "PCL-0028", "PCL-0030"] },
  ];

  const tagDefs = [
    { name: "Fast-moving", skus: ["PCL-0001", "PCL-0009", "PCL-0003"] },
    { name: "Prescription", skus: ["PCL-0002", "PCL-0010", "PCL-0026"] },
    { name: "OTC", skus: ["PCL-0005", "PCL-0024", "PCL-0027"] },
    { name: "Low-stock-demo", skus: ["PCL-0005", "PCL-0022"] },
  ];

  for (const c of categoryDefs) {
    let cat = await prisma.productCategory.findFirst({
      where: { tenantId: tenant.id, name: c.name, parentCategoryId: null },
    });
    if (!cat) {
      cat = await prisma.productCategory.create({
        data: { tenantId: tenant.id, name: c.name },
      });
    }
    for (const sku of c.skus) {
      const productId = productBySku.get(sku);
      if (!productId) continue;
      await prisma.productCategoryMap.create({
        data: { tenantId: tenant.id, productId, categoryId: cat.id },
      });
    }
  }

  for (const t of tagDefs) {
    const tag = await prisma.productTag.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: t.name } },
      update: {},
      create: { tenantId: tenant.id, name: t.name },
    });
    for (const sku of t.skus) {
      const productId = productBySku.get(sku);
      if (!productId) continue;
      await prisma.productTagMap.create({
        data: { tenantId: tenant.id, productId, tagId: tag.id },
      });
    }
  }

  const aliasDefs = [
    { sku: "PCL-0001", aliases: ["Panadol", "Paracetamol 500", "PCM 500"] },
    { sku: "PCL-0002", aliases: ["Amoxil", "Amoxicillin caps"] },
    { sku: "PCL-0005", aliases: ["Zyrtec", "Cetirizine"] },
    { sku: "PCL-0021", aliases: ["MS Contin", "Morphine 10mg"] },
  ];

  for (const a of aliasDefs) {
    const productId = productBySku.get(a.sku)!;
    for (const text of a.aliases) {
      await prisma.productAlias.create({
        data: { tenantId: tenant.id, productId, aliasText: text, aliasType: "synonym" },
      });
    }
  }

  const batchByKey = new Map<string, { batchId: string; productId: string; sellingPrice: Prisma.Decimal }>();
  const seedGrId = "00000000-0000-4000-8000-000000000001";

  for (const line of MAIN_STOCK) {
    const productId = productBySku.get(line.sku)!;
    const ref = await seedReceiveStock(prisma, {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      productId,
      userId: inventoryClerk.id,
      batchNo: `SEED-${line.sku}-A`,
      expiryDate: dateOnly(2026, 8, 15),
      qty: line.qty,
      costPrice: line.cost,
      sellingPrice: line.sell,
      referenceId: seedGrId,
      receivedAt: daysAgo(45),
    });
    batchByKey.set(`MAIN:${line.sku}`, ref);
  }

  const seedGrNearId = "00000000-0000-4000-8000-000000000003";
  const nearExpiryLines: Array<{ sku: string; qty: number; daysUntilExpiry: number; suffix: string }> =
    [
      { sku: "PCL-0005", qty: 12, daysUntilExpiry: 8, suffix: "NEAR-A" },
      { sku: "PCL-0017", qty: 6, daysUntilExpiry: 14, suffix: "NEAR-B" },
      { sku: "PCL-0024", qty: 4, daysUntilExpiry: 22, suffix: "NEAR-C" },
      { sku: "PCL-0013", qty: 8, daysUntilExpiry: 5, suffix: "NEAR-D" },
    ];
  for (const line of nearExpiryLines) {
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
    });
  }

  const expiredLine = { sku: "PCL-0018", qty: 5 };
  const expiredStock = MAIN_STOCK.find((s) => s.sku === expiredLine.sku);
  await seedReceiveStock(prisma, {
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
  });

  const seedGr2Id = "00000000-0000-4000-8000-000000000002";
  for (const line of BRANCH2_STOCK) {
    const productId = productBySku.get(line.sku)!;
    const ref = await seedReceiveStock(prisma, {
      tenantId: tenant.id,
      branchId: secondBranch.id,
      productId,
      userId: inventoryClerk.id,
      batchNo: `SEED-${line.sku}-KDY`,
      expiryDate: dateOnly(2026, 10, 1),
      qty: line.qty,
      costPrice: line.cost,
      sellingPrice: line.sell,
      referenceId: seedGr2Id,
      receivedAt: daysAgo(30),
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

  await prisma.purchaseOrder.create({
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

  const transferRequested = await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
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

  await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
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
  });

  const transferInTransit = await prisma.transfer.create({
    data: {
      tenantId: tenant.id,
      fromBranchId: mainBranch.id,
      toBranchId: secondBranch.id,
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
  type ReturnSeedDef = {
    number: string;
    type: GoodsReturnType;
    status: GoodsReturnStatus;
    daysAgo: number;
    reason: string;
    customerName?: string;
    supplierId?: string;
    saleId?: string;
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
    { number: "RET-2026-00014", type: GoodsReturnType.supplier, status: GoodsReturnStatus.awaiting_logistics, daysAgo: 6, reason: "Recall — batch hold", supplierId: supplier1.id, amount: 5200, lines: [{ sku: "PCL-0027", qty: 8, unitPrice: 650 }] },
    { number: "RET-2026-00015", type: GoodsReturnType.customer, status: GoodsReturnStatus.awaiting_logistics, daysAgo: 9, reason: "Customer bringing unused pack", customerName: "Heshan Bandara", amount: 295, lines: [{ sku: "PCL-0018", qty: 1, unitPrice: 295 }] },
    { number: "RET-2026-00016", type: GoodsReturnType.supplier, status: GoodsReturnStatus.awaiting_logistics, daysAgo: 10, reason: "Overstock return to supplier", supplierId: supplier2.id, amount: 1500, lines: [{ sku: "PCL-0003", qty: 5, unitPrice: 300 }] },
    { number: "RET-2026-00017", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 4, reason: "Condition check after pickup", customerName: "Malsha Perera", amount: 720, lines: [{ sku: "PCL-0009", qty: 1, unitPrice: 720 }] },
    { number: "RET-2026-00018", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 7, reason: "Verify batch before refund", customerName: "Tharindu Jay", amount: 1100, lines: [{ sku: "PCL-0004", qty: 1, unitPrice: 1100 }] },
    { number: "RET-2026-00019", type: GoodsReturnType.supplier, status: GoodsReturnStatus.in_review, daysAgo: 8, reason: "Awaiting supplier RMA confirmation", supplierId: supplier1.id, amount: 2800, lines: [{ sku: "PCL-0012", qty: 7, unitPrice: 400 }] },
    { number: "RET-2026-00020", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 11, reason: "Cold-chain product inspection", customerName: "Clinic walk-in", amount: 1950, lines: [{ sku: "PCL-0015", qty: 3, unitPrice: 650 }] },
    { number: "RET-2026-00021", type: GoodsReturnType.supplier, status: GoodsReturnStatus.in_review, daysAgo: 12, reason: "Credit note pending", supplierId: supplier2.id, amount: 900, lines: [{ sku: "PCL-0008", qty: 3, unitPrice: 300 }] },
    { number: "RET-2026-00022", type: GoodsReturnType.customer, status: GoodsReturnStatus.in_review, daysAgo: 3, reason: "Photo evidence under review", customerName: "Ishara Fonseka", amount: 430, lines: [{ sku: "PCL-0010", qty: 2, unitPrice: 215 }] },
    { number: "RET-2026-00023", type: GoodsReturnType.customer, status: GoodsReturnStatus.completed, daysAgo: 20, reason: "Unused sealed pack", customerName: "Gayani Silva", amount: 540, lines: [{ sku: "PCL-0001", qty: 2, unitPrice: 270 }] },
    { number: "RET-2026-00024", type: GoodsReturnType.customer, status: GoodsReturnStatus.completed, daysAgo: 25, reason: "Refund processed at counter", customerName: "Counter refund", amount: 380, lines: [{ sku: "PCL-0009", qty: 1, unitPrice: 380 }] },
    { number: "RET-2026-00025", type: GoodsReturnType.supplier, status: GoodsReturnStatus.completed, daysAgo: 28, reason: "Supplier credit received", supplierId: supplier1.id, amount: 4200, lines: [{ sku: "PCL-0007", qty: 10, unitPrice: 420 }] },
    { number: "RET-2026-00026", type: GoodsReturnType.customer, status: GoodsReturnStatus.completed, daysAgo: 15, reason: "Exchange completed", customerName: "Nimali Ratnayake", amount: 260, lines: [{ sku: "PCL-0015", qty: 2, unitPrice: 130 }] },
    { number: "RET-2026-00027", type: GoodsReturnType.supplier, status: GoodsReturnStatus.completed, daysAgo: 18, reason: "Damaged carton credited", supplierId: supplier2.id, amount: 1600, lines: [{ sku: "PCL-0019", qty: 4, unitPrice: 400 }] },
    { number: "RET-2026-00028", type: GoodsReturnType.customer, status: GoodsReturnStatus.rejected, daysAgo: 9, reason: "Opened pack — policy decline", customerName: "Opened pack claim", amount: 890, lines: [{ sku: "PCL-0006", qty: 1, unitPrice: 890 }], notes: "Rejected — seal broken" },
    { number: "RET-2026-00029", type: GoodsReturnType.supplier, status: GoodsReturnStatus.rejected, daysAgo: 14, reason: "Outside return window", supplierId: supplier1.id, amount: 3000, lines: [{ sku: "PCL-0027", qty: 5, unitPrice: 600 }] },
    { number: "RET-2026-00030", type: GoodsReturnType.customer, status: GoodsReturnStatus.rejected, daysAgo: 16, reason: "No proof of purchase", customerName: "Unknown walk-in", amount: 210, lines: [{ sku: "PCL-0022", qty: 1, unitPrice: 210 }] },
  ];

  for (const def of returnDefs) {
    const approved =
      def.status !== GoodsReturnStatus.draft &&
      def.status !== GoodsReturnStatus.pending_approval &&
      def.status !== GoodsReturnStatus.rejected;
    const processed =
      def.status === GoodsReturnStatus.in_review ||
      def.status === GoodsReturnStatus.completed;

    const created = await prisma.goodsReturn.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        returnNumber: def.number,
        type: def.type,
        status: def.status,
        customerName: def.customerName ?? null,
        supplierId: def.supplierId ?? null,
        saleId: null,
        reason: def.reason,
        notes: def.notes ?? null,
        amount: dec(def.amount),
        requestedBy: def.type === GoodsReturnType.customer ? cashier.id : inventoryClerk.id,
        approvedBy: approved || def.status === GoodsReturnStatus.rejected ? manager.id : null,
        processedBy: processed ? manager.id : null,
        createdAt: daysAgo(def.daysAgo),
        updatedAt: daysAgo(Math.max(0, def.daysAgo - 1)),
        items: {
          create: def.lines.map((line) => {
            const ref = batchByKey.get(`MAIN:${line.sku}`);
            return {
              tenantId: tenant.id,
              productId: productBySku.get(line.sku)!,
              batchId: ref?.batchId ?? null,
              qty: line.qty,
              unitPrice: dec(line.unitPrice),
            };
          }),
        },
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
              branchId: mainBranch.id,
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
              branchId: mainBranch.id,
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

  const returnCount = await prisma.goodsReturn.count({ where: { tenantId: tenant.id } });

  const batchCount = await prisma.batch.count({ where: { tenantId: tenant.id } });
  const ledgerCount = await prisma.stockLedger.count({ where: { tenantId: tenant.id } });
  const poCount = await prisma.purchaseOrder.count({ where: { tenantId: tenant.id } });
  const transferCount = await prisma.transfer.count({ where: { tenantId: tenant.id } });

  console.log("\n=== PharmaCeylon demo seed complete ===\n");
  console.log(`Tenant:     ${TENANT_CODE} (${tenant.displayName})`);
  console.log(`Branches:   ${mainBranch.code}, ${secondBranch.code}`);
  console.log(`Products:   ${PRODUCTS.length}`);
  console.log(`Batches:    ${batchCount}`);
  console.log(`Ledger:     ${ledgerCount} movements`);
  console.log(`Sales:      ${saleCount} invoices`);
  console.log(`POs:        ${poCount} (draft, pending, issued, partial, received, cancelled)`);
  console.log(`Transfers:  ${transferCount} (requested → approved → in transit → partial/received)`);
  console.log(`Returns:    ${returnCount} (customer + supplier across workflow statuses)`);
  console.log("\nLogins (passwords from SEED_*_PASSWORD or defaults):");
  console.log("  admin@pharmaceylon.demo      — owner");
  console.log("  manager@pharmaceylon.demo    — manager");
  console.log("  pharmacist@pharmaceylon.demo — pharmacist");
  console.log("  cashier@pharmaceylon.demo    — cashier");
  console.log("  clerk@pharmaceylon.demo      — inventory_clerk");
  console.log("\nDefaults: ChangeMe123! / Manager123! / Pharmacist123! / Cashier123! / Clerk123!");
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
