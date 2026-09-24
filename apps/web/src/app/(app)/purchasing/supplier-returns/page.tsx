"use client";

import { Suspense } from "react";
import { ReturnsContent } from "../../returns/returns-content";
import { PurchasingSubnav } from "../components/purchasing-subnav";

/**
 * Supplier returns, with the rest of Purchasing.
 *
 * Sending stock back to a vendor belongs with the orders, deliveries and invoices it relates to:
 * completing one raises a debit note that reduces what is owed, which is found on the Invoices
 * tab. It is the same Returns screen, pinned to supplier returns, so every existing link to a
 * return keeps working.
 */
export default function SupplierReturnsPage() {
  return (
    <Suspense fallback={null}>
      <ReturnsContent lockedType="supplier" subnav={<PurchasingSubnav />} />
    </Suspense>
  );
}
