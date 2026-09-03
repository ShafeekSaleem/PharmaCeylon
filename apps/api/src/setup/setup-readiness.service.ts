import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";

export type ReadinessTaskKey =
  | "business_branch"
  | "products"
  | "opening_inventory"
  | "sales_settings"
  | "checkout";

export type SetupReadiness = {
  journeyEnabled: boolean;
  readyForSales: boolean;
  completedCount: number;
  totalCount: number;
  percent: number;
  tenant: { id: string; name: string; hasLogo: boolean };
  branch: { id: string; name: string; code: string; setupMode: string };
  tasks: Array<{
    key: ReadinessTaskKey;
    title: string;
    description: string;
    complete: boolean;
    available: boolean;
    href: string;
  }>;
  optional: {
    teamInvited: boolean;
    logoAdded: boolean;
  };
  nextTask: ReadinessTaskKey | null;
};

@Injectable()
export class SetupReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string, branchId: string): Promise<SetupReadiness> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId },
      select: {
        id: true,
        code: true,
        name: true,
        addressLine1: true,
        timezone: true,
        setupRequired: true,
        setupMode: true,
        setupCompletedAt: true,
        salesSettingsReviewedAt: true,
        checkoutPreparedAt: true,
        tenant: {
          select: {
            id: true,
            displayName: true,
            legalName: true,
            currency: true,
            timezone: true,
            logoUrl: true,
          },
        },
      },
    });
    if (!branch) throw new NotFoundException("Branch not found");

    const [productCount, referenceCount, stockGroups, team] = await Promise.all([
      // Only the pharmacy's own range counts. Importing the NMRA registry used to tick this
      // step off before the shop had decided what it actually sells.
      this.prisma.product.count({
        where: { tenantId, isActive: true, rangeStatus: "RANGED" },
      }),
      // Whether there is a reference catalog to search yet. A brand-new pharmacy has none, so
      // "search the catalog and add what you stock" would send it to an empty page.
      this.prisma.product.count({
        where: { tenantId, rangeStatus: "REFERENCE" },
      }),
      this.prisma.stockLedger.groupBy({
        by: ["batchId"],
        where: { tenantId, branchId, batchId: { not: null } },
        _sum: { qtyDelta: true },
      }),
      this.prisma.userBranchRole.findMany({
        where: { tenantId, branchId, user: { isActive: true } },
        distinct: ["userId"],
        select: { userId: true },
      }),
    ]);

    const businessComplete = Boolean(
      branch.tenant.displayName.trim() &&
      branch.tenant.legalName.trim() &&
      branch.tenant.currency.trim() &&
      branch.tenant.timezone.trim() &&
      branch.name.trim() &&
      branch.addressLine1?.trim() &&
      branch.timezone.trim(),
    );
    const productsComplete = productCount > 0;
    const stockComplete = stockGroups.some(
      (row) => (row._sum.qtyDelta ?? 0) > 0,
    );
    const salesSettingsComplete = branch.salesSettingsReviewedAt !== null;
    const checkoutComplete = branch.checkoutPreparedAt !== null;

    // The wizard asked how the pharmacy is getting started and then nothing acted on the
    // answer. These two steps are where it actually pays off: a shop moving from another
    // system should be pointed at the importer, not at an empty product form, and one opening
    // fresh should be pointed at the catalog it can build a range from.
    const migrating = branch.setupMode === "migrating";
    const hasReferenceCatalog = referenceCount > 0;

    const tasks: SetupReadiness["tasks"] = [
      {
        key: "business_branch",
        title: "Business & branch details",
        description: "Your pharmacy and branch information is saved.",
        complete: businessComplete,
        available: true,
        href: "/settings/tenant-profile",
      },
      migrating
        ? {
            key: "products",
            title: "Import your product list",
            description:
              "Upload the export from your old system — products and opening stock in one file.",
            complete: productsComplete,
            available: true,
            href: "/products/import",
          }
        : hasReferenceCatalog
          ? {
              key: "products",
              title: "Build your product range",
              description:
                "Search the catalog for what you stock and add it to your products.",
              complete: productsComplete,
              available: true,
              href: "/products?scope=reference",
            }
          : {
              // Nothing to search yet. Load the register first, or the step above is a
              // link to an empty page.
              key: "products",
              title: "Load the medicines catalog",
              description:
                "Import the NMRA register once — then search it and pick what you stock.",
              complete: productsComplete,
              available: true,
              href: "/products?import=nmra",
            },
      migrating
        ? {
            key: "opening_inventory",
            title: "Check your opening stock",
            description:
              "Your import can carry stock on the same rows — add anything it didn't cover.",
            complete: stockComplete,
            available: productsComplete,
            href: "/inventory/batches",
          }
        : {
            key: "opening_inventory",
            title: "Add opening inventory",
            description: "Add batches, expiry dates, quantities and costs.",
            complete: stockComplete,
            available: productsComplete,
            href: "/inventory/adjustments",
          },
      {
        key: "sales_settings",
        title: "Review sales settings",
        description: "Confirm pricing, tax treatment, payments and receipts.",
        complete: salesSettingsComplete,
        available: true,
        href: "/settings/main?from=get-started",
      },
      {
        key: "checkout",
        title: "Prepare your checkout",
        description: "Confirm your register and checkout configuration.",
        complete: checkoutComplete,
        available: salesSettingsComplete,
        href: "/pos?setup=checkout",
      },
    ];

    const completedCount = tasks.filter((task) => task.complete).length;
    const readyForSales = completedCount === tasks.length;
    if (readyForSales && !branch.setupCompletedAt) {
      await this.prisma.branch.updateMany({
        where: { id: branchId, tenantId, setupCompletedAt: null },
        data: { setupCompletedAt: new Date() },
      });
    }

    return {
      journeyEnabled: branch.setupRequired,
      readyForSales,
      completedCount,
      totalCount: tasks.length,
      percent: Math.round((completedCount / tasks.length) * 100),
      tenant: {
        id: branch.tenant.id,
        name: branch.tenant.displayName,
        hasLogo: Boolean(branch.tenant.logoUrl),
      },
      branch: {
        id: branch.id,
        name: branch.name,
        code: branch.code,
        setupMode: branch.setupMode,
      },
      tasks,
      optional: {
        teamInvited: team.length > 1,
        logoAdded: Boolean(branch.tenant.logoUrl),
      },
      nextTask:
        tasks.find((task) => !task.complete && task.available)?.key ?? null,
    };
  }

  async confirm(
    tenantId: string,
    branchId: string,
    userId: string,
    task: "sales_settings" | "checkout",
  ): Promise<SetupReadiness> {
    const current = await this.get(tenantId, branchId);
    if (!current.journeyEnabled) {
      throw new ConflictException(
        "Setup journey is not enabled for this branch",
      );
    }
    if (
      task === "checkout" &&
      !current.tasks.find((item) => item.key === "sales_settings")?.complete
    ) {
      throw new ConflictException(
        "Review sales settings before confirming checkout",
      );
    }

    const changedAt = new Date();
    await this.prisma.branch.updateMany({
      where: { id: branchId, tenantId },
      data:
        task === "sales_settings"
          ? { salesSettingsReviewedAt: changedAt }
          : { checkoutPreparedAt: changedAt },
    });
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: `onboarding.${task}_confirmed`,
      entityName: "branch",
      entityId: branchId,
    });
    return this.get(tenantId, branchId);
  }

  async assertCanSell(tenantId: string, branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId },
      select: { setupRequired: true, setupCompletedAt: true },
    });
    if (!branch?.setupRequired || branch.setupCompletedAt) return;
    const readiness = await this.get(tenantId, branchId);
    if (!readiness.readyForSales) {
      const remaining = readiness.tasks
        .filter((task) => !task.complete)
        .map((task) => task.title);
      throw new ConflictException({
        statusCode: 409,
        code: "BRANCH_SETUP_INCOMPLETE",
        message:
          "Finish the required branch setup before completing a real sale.",
        remaining,
        nextPath: "/get-started",
      });
    }
  }
}
