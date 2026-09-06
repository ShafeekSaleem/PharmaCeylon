import { redirect } from "next/navigation";

/**
 * The Organize worklist is now the Work Queue's "Needs category" filter.
 *
 * Kept as a redirect rather than deleted: this path was linked from the Get-started journey,
 * from import completion screens, and from whatever anyone bookmarked. A 404 for a screen that
 * moved is a support ticket.
 */
export default function OrganizeRedirect() {
  redirect("/products/manage?view=needs_category");
}
