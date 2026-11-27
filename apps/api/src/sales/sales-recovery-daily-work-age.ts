import { Prisma } from "@prisma/client";
import { SALES_RECOVERY_DAILY_WORK_MAX_AGE_DAYS } from "@pharmaceylon/shared";

const maxAgeInterval = Prisma.sql`(${SALES_RECOVERY_DAILY_WORK_MAX_AGE_DAYS}::int * interval '1 day')`;

/** UTC wall clock; daily-work timestamp columns are `timestamp` (no zone) storing UTC. */
const utcNow = Prisma.sql`(NOW() AT TIME ZONE 'UTC')`;

/** Postgres: source timestamp is within the daily-work visibility window (not queue listing). */
export function salesRecoveryDailyWorkFreshSql(sourceTimestampColumn: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(sourceTimestampColumn)} >= ${utcNow} - ${maxAgeInterval}`;
}