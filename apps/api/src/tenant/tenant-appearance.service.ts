import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import {
  DEFAULT_PHARMACY_APPEARANCE,
  validatePharmacyAppearance,
  type PharmacyAppearance,
  type PharmacyAppearanceSettings,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { UpdateTenantAppearanceDto } from "./dto/tenant-appearance.dto";

const SELECT = {
  accent: true,
  sidebarStyle: true,
  chartPalette: true,
  statusSet: true,
  counterTheme: true,
  counterThemeLocked: true,
  version: true,
  updatedAt: true,
} as const;

type Row = Prisma.TenantAppearanceGetPayload<{ select: typeof SELECT }>;

/**
 * The pharmacy brand (Epic UI1 #205, decision 4). Everyone signed in at the pharmacy reads it,
 * since every page draws with it; only an owner changes it. Each save names the version the
 * owner's form loaded, so two owners editing at once can't silently overwrite each other, and
 * the audit event commits with the change.
 */
@Injectable()
export class TenantAppearanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string): Promise<PharmacyAppearance> {
    const row = await this.prisma.tenantAppearance.findUnique({
      where: { tenantId },
      select: SELECT,
    });
    return view(row);
  }

  async update(
    user: RequestUser,
    dto: UpdateTenantAppearanceDto,
  ): Promise<PharmacyAppearance> {
    if (!user.branchRoles.some((entry) => entry.role === RoleName.owner)) {
      throw new ForbiddenException(
        "Only an owner can change the pharmacy's appearance",
      );
    }
    const parsed = validatePharmacyAppearance(dto.appearance);
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const next = parsed.value;

    const saved = await this.prisma.$transaction(async (tx) => {
      const before = await tx.tenantAppearance.findUnique({
        where: { tenantId: user.tenantId },
        select: SELECT,
      });
      const current = before?.version ?? 0;
      if (current !== dto.expectedVersion) throw stale();

      let row: Row;
      if (!before) {
        try {
          row = await tx.tenantAppearance.create({
            data: {
              tenantId: user.tenantId,
              ...next,
              version: 1,
              updatedByUserId: user.userId,
            },
            select: SELECT,
          });
        } catch (error) {
          // Another owner created it between our read and write.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          )
            throw stale();
          throw error;
        }
      } else {
        const changed = await tx.tenantAppearance.updateMany({
          where: { tenantId: user.tenantId, version: dto.expectedVersion },
          data: {
            ...next,
            version: { increment: 1 },
            updatedByUserId: user.userId,
          },
        });
        if (changed.count !== 1) throw stale();
        row = await tx.tenantAppearance.findUniqueOrThrow({
          where: { tenantId: user.tenantId },
          select: SELECT,
        });
      }

      await this.audit.log(
        {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          eventName: "tenant.appearance_updated",
          entityName: "tenant",
          entityId: user.tenantId,
          payload: {
            fromVersion: current,
            toVersion: row.version,
            from: settingsOf(before),
            to: next,
          } as unknown as Prisma.InputJsonValue,
        },
        tx,
      );
      return row;
    });
    return view(saved);
  }
}

function stale() {
  return new ConflictException(
    "Someone else changed the pharmacy's appearance. Reload it before saving again.",
  );
}

function settingsOf(row: Row | null): PharmacyAppearanceSettings {
  if (!row) return { ...DEFAULT_PHARMACY_APPEARANCE };
  return {
    accent: row.accent,
    sidebarStyle:
      row.sidebarStyle as PharmacyAppearanceSettings["sidebarStyle"],
    chartPalette:
      row.chartPalette as PharmacyAppearanceSettings["chartPalette"],
    statusSet: row.statusSet as PharmacyAppearanceSettings["statusSet"],
    counterTheme:
      row.counterTheme as PharmacyAppearanceSettings["counterTheme"],
    counterThemeLocked: row.counterThemeLocked,
  };
}

function view(row: Row | null): PharmacyAppearance {
  return {
    ...settingsOf(row),
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}
