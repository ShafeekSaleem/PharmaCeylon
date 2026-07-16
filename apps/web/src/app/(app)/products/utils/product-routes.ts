/** Deep links from a product detail page to operational modules (placeholders until built). */

export type ProductNavLink = {
  id: string;
  label: string;
  description: string;
  href: string;
  ready: boolean;
};

export function productDetailPath(productId: string, query?: Record<string, string>): string {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  return qs ? `/products/${productId}?${qs}` : `/products/${productId}`;
}

export function productsListPath(listQuery?: string): string {
  if (!listQuery?.trim()) return "/products";
  const q = listQuery.startsWith("?") ? listQuery.slice(1) : listQuery;
  return `/products?${q}`;
}

/** Restrict back-navigation targets to same-origin relative paths. */
export function sanitizeReturnPath(raw: string | null | undefined): string {
  if (!raw?.trim()) return "/products";
  const path = raw.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return "/products";
  return path;
}

type ProductLinkContext = {
  sku?: string;
  name?: string;
};

export function productOperationalLinks(
  productId: string,
  ctx?: ProductLinkContext,
): ProductNavLink[] {
  const q = `productId=${productId}`;
  const catalogQuery = encodeURIComponent(ctx?.sku?.trim() || ctx?.name?.trim() || productId);
  return [
    {
      id: "inventory",
      label: "Inventory",
      description: "Stock levels and ledger for this product",
      href: `/inventory?${q}`,
      ready: true,
    },
    {
      id: "batches",
      label: "Batch stock",
      description: "Receive, adjust, and trace batches",
      href: `/inventory/batches?${q}`,
      ready: true,
    },
    {
      id: "adjustments",
      label: "Stock adjustment",
      description: "Correct on-hand quantity at this branch",
      href: `/inventory/adjustments?${q}`,
      ready: true,
    },
    {
      id: "purchasing",
      label: "Create purchase order",
      description: "Order more stock from a supplier",
      href: `/purchasing?${q}&action=create-po`,
      ready: false,
    },
    {
      id: "transfers",
      label: "Add to transfer",
      description: "Move stock between branches",
      href: `/transfers?${q}&action=add-line`,
      ready: false,
    },
    {
      id: "pos",
      label: "POS / checkout",
      description: "Sell this product at the register",
      href: `/pos?${q}`,
      ready: true,
    },
    {
      id: "catalog",
      label: "Search catalog",
      description: "Pharmacist catalog view",
      href: `/catalog?q=${catalogQuery}`,
      ready: true,
    },
    {
      id: "audit",
      label: "Audit log",
      description: "Full change history for this product",
      href: `/audit?entityName=product&entityId=${productId}`,
      ready: true,
    },
  ];
}
