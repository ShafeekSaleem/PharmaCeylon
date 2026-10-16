/** Sources needed by widgets using the shared payload (self-fetching charts handle their own errors). */
export function widgetDataSources(key: string): string[] {
  if (key.endsWith(".prescription-queue")) return ["Held bills"];
  if (key.endsWith(".held-bills")) return ["Held bills", "Sales metrics"];
  if (key.endsWith(".recent-transactions"))
    return ["Recent sales", "Sales metrics"];
  if (
    /\.(shift-performance|payment-methods|dispensing-throughput|frequently-dispensed|fast-moving-items|top-products-today|staff-productivity)$/.test(
      key,
    )
  )
    return ["Sales metrics"];
  if (key.endsWith(".controlled-drug-activity")) return ["Stock metrics"];
  if (/\.(stock-watch|inventory-health)$/.test(key))
    return ["Inventory summary", "Stock metrics", "Expiry batches"];
  if (/\.(expiry-watch|batch-expiry-monitor)$/.test(key))
    return ["Expiry batches"];
  if (key.endsWith(".stocktakes")) return ["Stocktakes"];
  if (key.endsWith(".pending-pos")) return ["Purchase orders"];
  if (/\.(pending-approvals|transfer-po-pipeline)$/.test(key))
    return ["Purchase orders", "Transfers", "Supplier returns"];
  if (key.endsWith(".ai-insights"))
    return [
      "Inventory summary",
      "Expiry batches",
      "Purchase orders",
      "Stock metrics",
    ];
  return [];
}
