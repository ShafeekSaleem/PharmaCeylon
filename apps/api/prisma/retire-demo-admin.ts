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
      select: { id: true, isActive: true },
    });
    if (!legacy) {
      console.log("No legacy admin@pharmaceylon.demo user — nothing to do.");
      return;
    }

    await prisma.userBranchRole.deleteMany({ where: { userId: legacy.id } });
    await prisma.appUser.update({
      where: { id: legacy.id },
      data: { isActive: false, fullName: "Retired Seed Admin" },
    });
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
