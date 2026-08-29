import { redirect } from "next/navigation";

/** Profitability Target folded into Settings → Catalog. Kept as a redirect (not deleted)
 *  so old bookmarks/report deep-links to this route still land somewhere useful. */
export default function ProfitabilityRedirectPage() {
  redirect("/settings/catalog");
}
