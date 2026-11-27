import { Prisma } from "@prisma/client";
import { lkrMinorLabelSql } from "../../src/common/lkr-money-format";
import { prisma } from "./offline-counter.kit";

describe("lkrMinorLabelSql", () => {
  async function labelFor(minor: bigint | number): Promise<string> {
    const [{ label }] = await prisma.$queryRaw<Array<{ label: string }>>(
      Prisma.sql`SELECT ${Prisma.raw(lkrMinorLabelSql(`(${minor})::bigint`))} AS label`,
    );
    return label;
  }

  it("formats minor units with grouped two-decimal LKR labels", async () => {
    await expect(labelFor(1500)).resolves.toBe("LKR 15.00");
    await expect(labelFor(1)).resolves.toBe("LKR 0.01");
    await expect(labelFor(0)).resolves.toBe("LKR 0.00");
    await expect(labelFor(125_050)).resolves.toBe("LKR 1,250.50");
    await expect(labelFor(9_999_999_999_990)).resolves.toBe("LKR 99,999,999,999.90");
    await expect(labelFor(-1500)).resolves.toBe("LKR -15.00");
  });
});