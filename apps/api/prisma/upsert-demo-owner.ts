/**
 * Idempotent upsert for the dedicated demo owner login.
 * Prefer `npm run prisma:seed -w api` for a full refresh; use this when you only
 * need owner@pharmaceylon.demo without re-seeding catalog / ops data.
 *
 *   npx tsx prisma/upsert-demo-owner.ts
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";

const TENANT_CODE = "demo";
const OWNER_EMAIL = "owner@pharmaceylon.demo";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "Owner123!";
  if (ownerPassword.length < 8) {
    throw new Error("SEED_OWNER_PASSWORD must be at least 8 characters");
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const tenant = await prisma.tenant.findUnique({ where: { code: TENANT_CODE } });
    if (!tenant) {
      throw new Error(
        `Tenant "${TENANT_CODE}" not found. Run full seed first: npm run prisma:seed -w api`,
      );
    }

    const branches = await prisma.branch.findMany({
      where: { tenantId: tenant.id, isActive: true },
      select: { id: true, code: true },
    });
    if (branches.length === 0) {
      throw new Error("No active branches on demo tenant. Run full seed first.");
    }

    const passwordHash = await bcrypt.hash(ownerPassword, 10);
    const owner = await prisma.appUser.upsert({
      where: { email: OWNER_EMAIL },
      update: {
        tenantId: tenant.id,
        fullName: "Seed Owner",
        isActive: true,
        passwordHash,
      },
      create: {
        tenantId: tenant.id,
        email: OWNER_EMAIL,
        fullName: "Seed Owner",
        passwordHash,
      },
    });

    await prisma.userBranchRole.deleteMany({
      where: { tenantId: tenant.id, userId: owner.id },
    });
    await prisma.userBranchRole.createMany({
      data: branches.map((branch) => ({
        tenantId: tenant.id,
        userId: owner.id,
        branchId: branch.id,
        role: RoleName.owner,
      })),
    });

    console.log(`Upserted ${OWNER_EMAIL} as owner on branches: ${branches.map((b) => b.code).join(", ")}`);
    console.log(`Password: SEED_OWNER_PASSWORD or default Owner123!`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
