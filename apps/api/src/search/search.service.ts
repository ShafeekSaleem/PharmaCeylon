import { Injectable } from "@nestjs/common";
import { PoStatus, Prisma, RoleName } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PERMISSION_KEYS } from "../security/permission-catalog";
import { PermissionsService } from "../security/permissions.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";

export type GlobalSearchResult = {
  id: string;
  type:
    | "product"
    | "sale"
    | "customer"
    | "supplier"
    | "purchase_order"
    | "transfer"
    | "stocktake";
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
  badge?: string;
  imageUrl?: string;
};

type SearchGroup = { key: string; label: string; items: GlobalSearchResult[] };

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async globalSearch(
    user: RequestUser,
    branchId: string | undefined,
    rawQuery: string,
    limit = 5,
  ) {
    const q = rawQuery.trim().replace(/\s+/g, " ");
    const granted = await this.grantedPermissions(user, branchId);
    const tasks: Array<Promise<SearchGroup | null>> = [];

    if (granted.has("products.view"))
      tasks.push(this.searchProducts(user.tenantId, branchId, q, limit));
    if (granted.has("sales.view"))
      tasks.push(this.searchSales(user.tenantId, branchId, q, limit));
    if (granted.has("customers.view"))
      tasks.push(this.searchCustomers(user.tenantId, q, limit));
    if (granted.has("suppliers.view"))
      tasks.push(this.searchSuppliers(user.tenantId, q, limit));
    if (granted.has("purchasing.view"))
      tasks.push(this.searchPurchaseOrders(user.tenantId, branchId, q, limit));
    if (granted.has("transfers.view"))
      tasks.push(this.searchTransfers(user.tenantId, branchId, q, limit));
    if (granted.has("stocktakes.use"))
      tasks.push(this.searchStocktakes(user.tenantId, branchId, q, limit));

    const groups = (await Promise.all(tasks)).filter(
      (group): group is SearchGroup => group != null && group.items.length > 0,
    );
    return {
      query: q,
      groups,
      total: groups.reduce((sum, group) => sum + group.items.length, 0),
    };
  }

  private async grantedPermissions(user: RequestUser, branchId?: string) {
    const candidates = branchId
      ? user.branchRoles.filter((entry) => entry.branchId === branchId)
      : user.branchRoles;
    if (user.branchRoles.some((entry) => entry.role === RoleName.owner)) {
      return new Set(PERMISSION_KEYS);
    }
    return this.permissions.resolveGrantedKeys(candidates);
  }

  private textFilter(q: string, fields: string[]): Prisma.ProductWhereInput[] {
    return fields.map((field) => ({
      [field]: { contains: q, mode: "insensitive" },
    })) as Prisma.ProductWhereInput[];
  }

  private async searchProducts(
    tenantId: string,
    branchId: string | undefined,
    q: string,
    limit: number,
  ): Promise<SearchGroup> {
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId,
        isActive: true,
        OR: this.textFilter(q, [
          "sku",
          "barcode",
          "name",
          "brandName",
          "genericName",
          "registrationNo",
        ]),
      },
      select: {
        id: true,
        sku: true,
        barcode: true,
        name: true,
        strength: true,
        unit: true,
        imageUrl: true,
      },
      orderBy: { updatedAt: "desc" },
      take: Math.max(limit * 2, limit),
    });
    const ranked = rows
      .sort((a, b) => this.matchRank(a, q) - this.matchRank(b, q))
      .slice(0, limit);
    const qty =
      branchId && ranked.length
        ? await this.prisma.stockLedger.groupBy({
            by: ["productId"],
            where: {
              tenantId,
              branchId,
              productId: { in: ranked.map((row) => row.id) },
            },
            _sum: { qtyDelta: true },
          })
        : [];
    const qtyMap = new Map(
      qty.map((row) => [row.productId, row._sum.qtyDelta ?? 0]),
    );
    return {
      key: "products",
      label: "Products",
      items: ranked.map((row) => ({
        id: row.id,
        type: "product",
        title: row.name,
        subtitle: [row.sku, row.strength, row.unit].filter(Boolean).join(" · "),
        meta: branchId ? `${qtyMap.get(row.id) ?? 0} on hand` : undefined,
        href: `/products/${row.id}`,
        badge: row.barcode === q ? "Barcode" : undefined,
        imageUrl: row.imageUrl ?? undefined,
      })),
    };
  }

  private matchRank(row: Record<string, unknown>, q: string) {
    const needle = q.toLowerCase();
    const values = Object.values(row).filter(
      (value): value is string => typeof value === "string",
    );
    if (values.some((value) => value.toLowerCase() === needle)) return 0;
    if (values.some((value) => value.toLowerCase().startsWith(needle)))
      return 1;
    return 2;
  }

  private async searchSales(
    tenantId: string,
    branchId: string | undefined,
    q: string,
    limit: number,
  ): Promise<SearchGroup> {
    const rows = await this.prisma.sale.findMany({
      where: {
        tenantId,
        ...(branchId ? { branchId } : {}),
        OR: [
          { invoiceNo: { contains: q, mode: "insensitive" } },
          { customer: { fullName: { contains: q, mode: "insensitive" } } },
          { customer: { phone: { contains: q, mode: "insensitive" } } },
        ],
      },
      include: {
        customer: { select: { fullName: true } },
        branch: { select: { name: true } },
      },
      orderBy: { soldAt: "desc" },
      take: limit,
    });
    return {
      key: "sales",
      label: "Sales & invoices",
      items: rows.map((row) => ({
        id: row.id,
        type: "sale",
        title: row.invoiceNo,
        subtitle: `${row.customer?.fullName ?? "Walk-in customer"} · ${row.branch.name}`,
        meta: `LKR ${Number(row.grandTotal).toLocaleString("en-LK", { minimumFractionDigits: 2 })}`,
        href: "/reports?category=sales&report=sales-summary",
        badge: row.status,
      })),
    };
  }

  private async searchCustomers(
    tenantId: string,
    q: string,
    limit: number,
  ): Promise<SearchGroup> {
    const rows = await this.prisma.customer.findMany({
      where: {
        tenantId,
        isActive: true,
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { phone: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return {
      key: "customers",
      label: "Customers",
      items: rows.map((row) => ({
        id: row.id,
        type: "customer",
        title: row.fullName,
        subtitle: row.phone ?? row.email ?? "Customer profile",
        href: `/pos?customerId=${row.id}`,
      })),
    };
  }

  private async searchSuppliers(
    tenantId: string,
    q: string,
    limit: number,
  ): Promise<SearchGroup> {
    const rows = await this.prisma.supplier.findMany({
      where: {
        tenantId,
        OR: [
          { code: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
          { contactName: { contains: q, mode: "insensitive" } },
          { phone: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return {
      key: "suppliers",
      label: "Suppliers",
      items: rows.map((row) => ({
        id: row.id,
        type: "supplier",
        title: row.name,
        subtitle: `${row.code} · ${row.type}`,
        href: `/suppliers?supplier=${row.id}`,
        badge: row.status,
      })),
    };
  }

  private async searchPurchaseOrders(
    tenantId: string,
    branchId: string | undefined,
    q: string,
    limit: number,
  ): Promise<SearchGroup> {
    const rows = await this.prisma.purchaseOrder.findMany({
      where: {
        tenantId,
        ...(branchId ? { branchId } : {}),
        OR: [
          { poNumber: { contains: q, mode: "insensitive" } },
          { supplierReference: { contains: q, mode: "insensitive" } },
          { supplier: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
      include: { supplier: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return {
      key: "purchase_orders",
      label: "Purchase orders",
      items: rows.map((row) => ({
        id: row.id,
        type: "purchase_order",
        title: row.poNumber,
        subtitle: row.supplier.name,
        meta: row.expectedOn
          ? `Expected ${row.expectedOn.toISOString().slice(0, 10)}`
          : undefined,
        href: `/purchasing?po=${row.id}`,
        badge:
          row.status === PoStatus.pending_approval ? "Approval" : row.status,
      })),
    };
  }

  private async searchTransfers(
    tenantId: string,
    branchId: string | undefined,
    q: string,
    limit: number,
  ): Promise<SearchGroup> {
    const rows = await this.prisma.transfer.findMany({
      where: {
        tenantId,
        ...(branchId
          ? { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] }
          : {}),
        AND: [
          {
            OR: [
              { transferNumber: { contains: q, mode: "insensitive" } },
              { fromBranch: { name: { contains: q, mode: "insensitive" } } },
              { toBranch: { name: { contains: q, mode: "insensitive" } } },
            ],
          },
        ],
      },
      include: {
        fromBranch: { select: { name: true } },
        toBranch: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return {
      key: "transfers",
      label: "Transfers",
      items: rows.map((row) => ({
        id: row.id,
        type: "transfer",
        title: row.transferNumber,
        subtitle: `${row.fromBranch.name} → ${row.toBranch.name}`,
        href: `/transfers?transfer=${row.id}`,
        badge: row.status,
      })),
    };
  }

  private async searchStocktakes(
    tenantId: string,
    branchId: string | undefined,
    q: string,
    limit: number,
  ): Promise<SearchGroup> {
    const rows = await this.prisma.stocktake.findMany({
      where: {
        tenantId,
        ...(branchId ? { branchId } : {}),
        OR: [
          { stocktakeNumber: { contains: q, mode: "insensitive" } },
          { title: { contains: q, mode: "insensitive" } },
          { areaLabel: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return {
      key: "stocktakes",
      label: "Stocktakes",
      items: rows.map((row) => ({
        id: row.id,
        type: "stocktake",
        title: row.stocktakeNumber,
        subtitle: row.title ?? row.areaLabel ?? "Stocktake",
        href: `/stocktakes/${row.id}`,
        badge: row.status,
      })),
    };
  }
}
