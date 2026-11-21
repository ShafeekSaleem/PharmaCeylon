import { redirect } from "next/navigation";

/** "Counters & receipts" split into Counters, Receipts and Payments (UI1 #205). Its counter
 *  defaults moved to Counters, so the old route lands there. The get-started step "Review
 *  sales settings" still links here (the href comes from the API). */
export default function MainSettingsRedirectPage() {
  redirect("/settings/counters");
}
