import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { ProductOrganizeService } from "../products/product-organize.service";
import { PrismaService } from "../prisma/prisma.service";

export type ReadinessTaskKey =
  | "business_branch"
  | "products"
  | "opening_inventory"
  | "sales_settings"
  | "checkout";

/** Steps whose completion is an explicit decision by the owner, not something derived. */
export type ConfirmableTaskKey =
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
    /**
     * What the owner is actually being asked to agree to. The three confirm-style steps used
     * to be a button with nothing behind it — you clicked "Confirm" without ever being shown
     * the settings you were confirming. These are the real current values, so the decision is
     * made against something.
     */
    facts?: Array<{ label: string; value: string; ok?: boolean }>;
  }>;
  optional: {
    teamInvited: boolean;
    logoAdded: boolean;
    /**
     * Catalog organisation is optional, not a gate: a shop can sell perfectly well with
     * everything in Unclassified, so blocking "ready for sales" on merchandising taxonomy
     * would be wrong. It sits here so the coverage figure is at least visible.
     */
    catalogOrganized: boolean;
    catalogCoverage: { ranged: number; categorized: number; unplaced: number; percent: number };
  };
  nextTask: ReadinessTaskKey | null;
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  mobile_wallet: "Mobile wallet",
  credit: "Customer credit",
};

@Injectable()
export class SetupReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly organize: ProductOrganizeService,
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
        openingStockConfirmedAt: true,
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
        _count: { select: { userBranchRoles: true } },
      },
    });
    if (!branch) throw new NotFoundException("Branch not found");

    const [productCount, referenceCount, stockGroups, team, settings, batchStats] =
      await Promise.all([
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
      this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: {
          posDefaultPaymentMethod: true,
          posAutoPrintReceipt: true,
          receiptHeaderText: true,
          receiptPaperSize: true,
        },
      }),
      this.prisma.batch.findMany({
        where: { tenantId, branchId },
        select: { id: true, needsExpiryReview: true },
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

    // Two different things: stock exists, and someone has agreed it is right. Only the
    // second completes the step — an import posts thousands of units in one go, and that is
    // exactly when a figure most needs checking against the shelf.
    const stockPosted = stockComplete;
    const openingStockComplete =
      stockPosted && branch.openingStockConfirmedAt !== null;

    const unitsPosted = stockGroups.reduce(
      (sum, row) => sum + Math.max(0, row._sum.qtyDelta ?? 0),
      0,
    );
    const batchesNeedingExpiry = batchStats.filter((b) => b.needsExpiryReview).length;

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
      {
        key: "opening_inventory",
        title: stockPosted
          ? "Confirm your opening stock"
          : migrating
            ? "Bring in your opening stock"
            : "Add opening inventory",
        description: stockPosted
          ? "Check these figures against the shelves, then confirm them."
          : migrating
            ? "Your import can carry stock on the same rows — or add it here."
            : "Add batches, expiry dates, quantities and costs.",
        complete: openingStockComplete,
        available: productsComplete,
        href: migrating ? "/inventory/batches" : "/inventory/adjustments",
        facts: stockPosted
          ? [
              {
                label: "Batches on the shelf",
                value: batchStats.length.toLocaleString(),
                ok: true,
              },
              { label: "Units counted", value: unitsPosted.toLocaleString(), ok: true },
              {
                label: "Missing an expiry date",
                value: batchesNeedingExpiry.toLocaleString(),
                ok: batchesNeedingExpiry === 0,
              },
            ]
          : undefined,
      },
      {
        key: "sales_settings",
        title: "Review sales settings",
        description: "These apply to every sale. Change anything that isn't right.",
        complete: salesSettingsComplete,
        available: true,
        href: "/settings/main?from=get-started",
        facts: [
          { label: "Currency", value: branch.tenant.currency, ok: true },
          {
            label: "Default payment",
            value: PAYMENT_LABELS[settings?.posDefaultPaymentMethod ?? "cash"] ?? "Cash",
            ok: true,
          },
          {
            label: "Receipt header",
            value: settings?.receiptHeaderText?.trim() || branch.tenant.displayName,
            ok: Boolean(settings?.receiptHeaderText?.trim() || branch.tenant.displayName),
          },
          {
            label: "Receipt paper",
            value: settings?.receiptPaperSize ?? "80mm",
            ok: true,
          },
        ],
      },
      {
        key: "checkout",
        title: "Prepare your checkout",
        description: "The last things the till needs before a real sale.",
        complete: checkoutComplete,
        available: salesSettingsComplete,
        href: "/pos?setup=checkout",
        facts: [
          {
            label: "Products ready to sell",
            value: productCount.toLocaleString(),
            ok: productsComplete,
          },
          {
            label: "Stock on the shelf",
            value: unitsPosted > 0 ? `${unitsPosted.toLocaleString()} units` : "None yet",
            ok: unitsPosted > 0,
          },
          {
            label: "Staff who can sell here",
            value: team.length.toLocaleString(),
            ok: team.length > 0,
          },
          {
            label: "Receipt printing",
            value: settings?.posAutoPrintReceipt ? "Automatic" : "Manual",
            ok: true,
          },
        ],
      },
    ];

    // Optional, so it is computed after the gating tasks and never affects readyForSales.
    const catalogCoverage = await this.organize.coverage(tenantId);

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
        catalogOrganized: catalogCoverage.unplaced === 0,
        catalogCoverage,
      },
      nextTask:
        tasks.find((task) => !task.complete && task.available)?.key ?? null,
    };
  }

  async confirm(
    tenantId: string,
    branchId: string,
    userId: string,
    task: ConfirmableTaskKey,
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

    if (task === "opening_inventory") {
      const current = await this.get(tenantId, branchId);
      const posted = current.tasks.find((t) => t.key === "opening_inventory")?.facts;
      if (!posted) {
        throw new ConflictException(
          "Add opening stock before confirming it — there is nothing to check yet.",
        );
      }
    }

    const changedAt = new Date();
    await this.prisma.branch.updateMany({
      where: { id: branchId, tenantId },
      data:
        task === "sales_settings"
          ? { salesSettingsReviewedAt: changedAt }
          : task === "opening_inventory"
            ? { openingStockConfirmedAt: changedAt }
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
