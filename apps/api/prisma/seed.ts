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
    where: {
      tenantId_email: { tenantId: tenant.id, email: "admin@pharmaceylon.demo" },
    },
    update: {
      fullName: "Seed Administrator",
      isActive: true,
    },
    create: {
      tenantId: tenant.id,
      email: "admin@pharmaceylon.demo",
      fullName: "Seed Administrator",
      passwordHash: adminHash,
    },
  });

  const cashier = await prisma.appUser.upsert({
    where: {
      tenantId_email: { tenantId: tenant.id, email: "cashier@pharmaceylon.demo" },
    },
    update: {
      fullName: "Seed Cashier",
      isActive: true,
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

  console.log("Seed completed.");
  console.log(`  Tenant code: ${TENANT_CODE}  (${tenant.displayName})`);
  console.log(`  Branches: ${mainBranch.code} (${mainBranch.id}), ${secondBranch.code} (${secondBranch.id})`);
  console.log(`  Admin:    admin@pharmaceylon.demo    (password from SEED_ADMIN_PASSWORD or default)`);
  console.log(`  Cashier:  cashier@pharmaceylon.demo  (password from SEED_CASHIER_PASSWORD or default)`);
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
