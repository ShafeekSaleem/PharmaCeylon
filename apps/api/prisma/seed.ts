import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error(
    "DATABASE_URL is not set. Create apps/api/.env from .env.example or export DATABASE_URL before seeding.",
  );
}

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });

const TENANT_CODE = "demo";

async function main() {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const cashierPassword = process.env.SEED_CASHIER_PASSWORD ?? "Cashier123!";

  if (adminPassword.length < 8 || cashierPassword.length < 8) {
    throw new Error("SEED_*_PASSWORD values must be at least 8 characters");
  }

  const tenant = await prisma.tenant.upsert({
    where: { code: TENANT_CODE },
    update: {
      displayName: "PharmaCeylon Demo Pharmacy",
      isActive: true,
    },
    create: {
      code: TENANT_CODE,
      legalName: "Demo Pharmacy (Private) Limited",
      displayName: "PharmaCeylon Demo Pharmacy",
      complianceRegion: "LK",
      timezone: "Asia/Colombo",
    },
  });

  const mainBranch = await prisma.branch.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "MAIN" } },
    update: {
      name: "Colombo — Main",
      isActive: true,
      timezone: "Asia/Colombo",
    },
    create: {
      tenantId: tenant.id,
      code: "MAIN",
      name: "Colombo — Main",
      timezone: "Asia/Colombo",
      city: "Colombo",
      addressLine1: "Demo Street 1",
    },
  });

  const secondBranch = await prisma.branch.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "BRANCH2" } },
    update: {
      name: "Kandy — Branch 2",
      isActive: true,
      timezone: "Asia/Colombo",
    },
    create: {
      tenantId: tenant.id,
      code: "BRANCH2",
      name: "Kandy — Branch 2",
      timezone: "Asia/Colombo",
      city: "Kandy",
    },
  });

  const adminHash = await bcrypt.hash(adminPassword, 10);
  const cashierHash = await bcrypt.hash(cashierPassword, 10);

  const admin = await prisma.appUser.upsert({
    where: { email: "admin@pharmaceylon.demo" },
    update: {
      tenantId: tenant.id,
      fullName: "Seed Administrator",
      isActive: true,
      passwordHash: adminHash,
    },
    create: {
      tenantId: tenant.id,
      email: "admin@pharmaceylon.demo",
      fullName: "Seed Administrator",
      passwordHash: adminHash,
    },
  });

  const cashier = await prisma.appUser.upsert({
    where: { email: "cashier@pharmaceylon.demo" },
    update: {
      tenantId: tenant.id,
      fullName: "Seed Cashier",
      isActive: true,
      passwordHash: cashierHash,
    },
    create: {
      tenantId: tenant.id,
      email: "cashier@pharmaceylon.demo",
      fullName: "Seed Cashier",
      passwordHash: cashierHash,
    },
  });

  await prisma.userBranchRole.deleteMany({
    where: {
      tenantId: tenant.id,
      userId: { in: [admin.id, cashier.id] },
    },
  });

  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: tenant.id, userId: admin.id, branchId: mainBranch.id, role: RoleName.owner },
      { tenantId: tenant.id, userId: admin.id, branchId: secondBranch.id, role: RoleName.owner },
      {
        tenantId: tenant.id,
        userId: cashier.id,
        branchId: mainBranch.id,
        role: RoleName.cashier,
      },
      {
        tenantId: tenant.id,
        userId: cashier.id,
        branchId: secondBranch.id,
        role: RoleName.cashier,
      },
    ],
  });

  const PRODUCTS = [
    { sku: "PCL-0001", name: "Paracetamol 500mg Tablets", genericName: "Paracetamol", brandName: "Panadol", manufacturer: "GlaxoSmithKline", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 50 },
    { sku: "PCL-0002", name: "Amoxicillin 500mg Capsules", genericName: "Amoxicillin", brandName: "Amoxil", manufacturer: "Pfizer", dosageForm: "Capsule", strength: "500mg", unit: "strip", reorderLevel: 30 },
    { sku: "PCL-0003", name: "Metformin 500mg Tablets", genericName: "Metformin HCl", brandName: "Glucophage", manufacturer: "Merck", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 40 },
    { sku: "PCL-0004", name: "Omeprazole 20mg Capsules", genericName: "Omeprazole", brandName: "Losec", manufacturer: "AstraZeneca", dosageForm: "Capsule", strength: "20mg", unit: "strip", reorderLevel: 25 },
    { sku: "PCL-0005", name: "Cetirizine 10mg Tablets", genericName: "Cetirizine HCl", brandName: "Zyrtec", manufacturer: "UCB Pharma", dosageForm: "Tablet", strength: "10mg", unit: "strip", reorderLevel: 20 },
    { sku: "PCL-0006", name: "Atorvastatin 20mg Tablets", genericName: "Atorvastatin Calcium", brandName: "Lipitor", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "20mg", unit: "strip", reorderLevel: 15 },
    { sku: "PCL-0007", name: "Losartan 50mg Tablets", genericName: "Losartan Potassium", brandName: "Cozaar", manufacturer: "Merck", dosageForm: "Tablet", strength: "50mg", unit: "strip", reorderLevel: 20 },
    { sku: "PCL-0008", name: "Amlodipine 5mg Tablets", genericName: "Amlodipine Besylate", brandName: "Norvasc", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "5mg", unit: "strip", reorderLevel: 25 },
    { sku: "PCL-0009", name: "Ibuprofen 400mg Tablets", genericName: "Ibuprofen", brandName: "Brufen", manufacturer: "Abbott", dosageForm: "Tablet", strength: "400mg", unit: "strip", reorderLevel: 35 },
    { sku: "PCL-0010", name: "Azithromycin 500mg Tablets", genericName: "Azithromycin", brandName: "Zithromax", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 15 },
    { sku: "PCL-0011", name: "Salbutamol Inhaler 100mcg", genericName: "Salbutamol", brandName: "Ventolin", manufacturer: "GlaxoSmithKline", dosageForm: "Inhaler", strength: "100mcg", unit: "piece", reorderLevel: 10 },
    { sku: "PCL-0012", name: "Metoprolol 50mg Tablets", genericName: "Metoprolol Tartrate", brandName: "Lopressor", manufacturer: "Novartis", dosageForm: "Tablet", strength: "50mg", unit: "strip", reorderLevel: 20 },
    { sku: "PCL-0013", name: "Diclofenac Sodium Gel 1%", genericName: "Diclofenac Sodium", brandName: "Voltaren", manufacturer: "Novartis", dosageForm: "Gel", strength: "1%", unit: "tube", reorderLevel: 15 },
    { sku: "PCL-0014", name: "Clopidogrel 75mg Tablets", genericName: "Clopidogrel", brandName: "Plavix", manufacturer: "Sanofi", dosageForm: "Tablet", strength: "75mg", unit: "strip", reorderLevel: 10 },
    { sku: "PCL-0015", name: "Pantoprazole 40mg Tablets", genericName: "Pantoprazole Sodium", brandName: "Protonix", manufacturer: "Pfizer", dosageForm: "Tablet", strength: "40mg", unit: "strip", reorderLevel: 20 },
    { sku: "PCL-0016", name: "Ciprofloxacin 500mg Tablets", genericName: "Ciprofloxacin HCl", brandName: "Cipro", manufacturer: "Bayer", dosageForm: "Tablet", strength: "500mg", unit: "strip", reorderLevel: 15 },
    { sku: "PCL-0017", name: "Levothyroxine 50mcg Tablets", genericName: "Levothyroxine Sodium", brandName: "Synthroid", manufacturer: "AbbVie", dosageForm: "Tablet", strength: "50mcg", unit: "strip", reorderLevel: 10 },
    { sku: "PCL-0018", name: "Prednisolone 5mg Tablets", genericName: "Prednisolone", brandName: "Prelone", manufacturer: "Sanofi", dosageForm: "Tablet", strength: "5mg", unit: "strip", reorderLevel: 15, isControlled: false },
    { sku: "PCL-0019", name: "Cephalexin 500mg Capsules", genericName: "Cephalexin", brandName: "Keflex", manufacturer: "Shionogi", dosageForm: "Capsule", strength: "500mg", unit: "strip", reorderLevel: 20 },
    { sku: "PCL-0020", name: "Furosemide 40mg Tablets", genericName: "Furosemide", brandName: "Lasix", manufacturer: "Sanofi", dosageForm: "Tablet", strength: "40mg", unit: "strip", reorderLevel: 15 },
    { sku: "PCL-0021", name: "Morphine Sulfate 10mg Tablets", genericName: "Morphine Sulfate", brandName: "MS Contin", manufacturer: "Purdue Pharma", dosageForm: "Tablet", strength: "10mg", unit: "strip", isControlled: true, reorderLevel: 5 },
    { sku: "PCL-0022", name: "Diazepam 5mg Tablets", genericName: "Diazepam", brandName: "Valium", manufacturer: "Roche", dosageForm: "Tablet", strength: "5mg", unit: "strip", isControlled: true, reorderLevel: 5 },
    { sku: "PCL-0023", name: "Codeine Phosphate 30mg Tablets", genericName: "Codeine Phosphate", brandName: "Codeine", manufacturer: "Johnson & Johnson", dosageForm: "Tablet", strength: "30mg", unit: "strip", isControlled: true, reorderLevel: 5 },
    { sku: "PCL-0024", name: "Betadine Solution 10%", genericName: "Povidone Iodine", brandName: "Betadine", manufacturer: "Mundipharma", dosageForm: "Solution", strength: "10%", unit: "bottle", reorderLevel: 10 },
    { sku: "PCL-0025", name: "Chlorhexidine Mouthwash", genericName: "Chlorhexidine Gluconate", brandName: "Savacol", manufacturer: "Colgate", dosageForm: "Solution", strength: "0.2%", unit: "bottle", reorderLevel: 8 },
    { sku: "PCL-0026", name: "Insulin Glargine 100IU/mL", genericName: "Insulin Glargine", brandName: "Lantus", manufacturer: "Sanofi", dosageForm: "Injection", strength: "100IU/mL", unit: "vial", reorderLevel: 5 },
    { sku: "PCL-0027", name: "Multivitamin Tablets", genericName: "Multivitamins", brandName: "Centrum", manufacturer: "Pfizer", dosageForm: "Tablet", strength: null, unit: "bottle", reorderLevel: 15 },
    { sku: "PCL-0028", name: "Vitamin D3 1000IU Soft Capsules", genericName: "Cholecalciferol", brandName: "D-Cal", manufacturer: "Herbalife", dosageForm: "Soft Capsule", strength: "1000IU", unit: "bottle", reorderLevel: 10 },
    { sku: "PCL-0029", name: "Ranitidine 150mg Tablets", genericName: "Ranitidine HCl", brandName: "Zantac", manufacturer: "GlaxoSmithKline", dosageForm: "Tablet", strength: "150mg", unit: "strip", reorderLevel: 20, isActive: false },
    { sku: "PCL-0030", name: "Clotrimazole Cream 1%", genericName: "Clotrimazole", brandName: "Canesten", manufacturer: "Bayer", dosageForm: "Cream", strength: "1%", unit: "tube", reorderLevel: 10 },
  ];

  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { tenantId_sku: { tenantId: tenant.id, sku: p.sku } },
      update: { name: p.name, brandName: p.brandName, genericName: p.genericName },
      create: {
        tenantId: tenant.id,
        sku: p.sku,
        name: p.name,
        genericName: p.genericName ?? null,
        brandName: p.brandName ?? null,
        manufacturer: p.manufacturer ?? null,
        dosageForm: p.dosageForm ?? null,
        strength: p.strength ?? null,
        unit: p.unit ?? null,
        isControlled: p.isControlled ?? false,
        reorderLevel: p.reorderLevel ?? 0,
        isActive: (p as { isActive?: boolean }).isActive ?? true,
      },
    });
  }

  const supplier = await prisma.supplier.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SUP-001" } },
    update: { name: "Lanka Pharma Distributors" },
    create: {
      tenantId: tenant.id,
      code: "SUP-001",
      name: "Lanka Pharma Distributors",
      leadTimeDays: 3,
      paymentTermsDays: 30,
    },
  });

  await prisma.supplier.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SUP-002" } },
    update: { name: "MediCare Imports (Pvt) Ltd" },
    create: {
      tenantId: tenant.id,
      code: "SUP-002",
      name: "MediCare Imports (Pvt) Ltd",
      leadTimeDays: 5,
      paymentTermsDays: 45,
    },
  });

  await prisma.supplier.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SUP-003" } },
    update: { name: "Colombo Medical Supplies" },
    create: {
      tenantId: tenant.id,
      code: "SUP-003",
      name: "Colombo Medical Supplies",
      leadTimeDays: 2,
      paymentTermsDays: 14,
    },
  });

  console.log("Seed completed.");
  console.log(`  Tenant code: ${TENANT_CODE}  (${tenant.displayName})`);
  console.log(`  Branches: ${mainBranch.code} (${mainBranch.id}), ${secondBranch.code} (${secondBranch.id})`);
  console.log(`  Admin:    admin@pharmaceylon.demo    (password from SEED_ADMIN_PASSWORD or default)`);
  console.log(`  Cashier:  cashier@pharmaceylon.demo  (password from SEED_CASHIER_PASSWORD or default)`);
  console.log(`  Products: ${PRODUCTS.length} pharmacy products seeded`);
  console.log(`  Suppliers: 3 suppliers seeded`);
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
