"use client";

import { PageSubnav, type PageSubnavTab } from "@/components/ui";
import { usePurchasingAccess } from "../hooks/use-purchasing-access";

/**
 * Purchasing is a workspace, not a page: an order, the delivery against it, the supplier's
 * bill for it, and anything sent back are views of one relationship with a supplier.
 *
 * Invoices only appear for someone who deals with the money — the clerk who books goods in
 * never sees payables — and Supplier returns for anyone who can see returns.
 */
export function PurchasingSubnav() {
  const access = usePurchasingAccess();
  const tabs: PageSubnavTab[] = [
    { href: "/purchasing", label: "Orders", match: (p) => p === "/purchasing" },
    { href: "/purchasing/deliveries", label: "Deliveries" },
    {
      href: "/purchasing/invoices",
      label: "Invoices",
      hidden: !(access.canInvoice || access.canPay),
    },
    { href: "/purchasing/supplier-returns", label: "Supplier returns", hidden: !access.canViewReturns },
  ];
  return <PageSubnav label="Purchasing sections" tabs={tabs} />;
}
