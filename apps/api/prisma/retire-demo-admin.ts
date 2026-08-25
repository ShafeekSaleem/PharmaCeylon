/**
 * Deactivate legacy admin@pharmaceylon.demo (no platform Admin role).
 *
 *   npx tsx prisma/retire-demo-admin.ts
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const legacy = await prisma.appUser.findUnique({
      where: { email: "admin@pharmaceylon.demo" },
      select: { id: true, tenantId: true, isActive: true },
    });
    if (!legacy) {
      console.log("No legacy admin@pharmaceylon.demo user — nothing to do.");
      return;
    }

    await prisma.userBranchRole.deleteMany({
      where: { tenantId: legacy.tenantId, userId: legacy.id },
    });
    const retired = await prisma.appUser.updateMany({
      where: { id: legacy.id, tenantId: legacy.tenantId },
      data: { isActive: false, fullName: "Retired Seed Admin" },
    });
    if (retired.count !== 1) {
      throw new Error("Legacy admin changed tenant or disappeared during retirement");
    }

    console.log("Deactivated admin@pharmaceylon.demo and removed all branch roles.");
    console.log("Use owner@pharmaceylon.demo / Owner123! for the owner dashboard.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
