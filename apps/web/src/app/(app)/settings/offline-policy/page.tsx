import { redirect } from "next/navigation";

/** "Offline policy" was renamed Offline selling (UI1 #205). Kept as a redirect so bookmarks
 *  and links from older builds still land on the page. */
export default function OfflinePolicyRedirectPage() {
  redirect("/settings/offline-selling");
}
