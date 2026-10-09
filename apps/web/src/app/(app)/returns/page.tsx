import { redirect } from "next/navigation";

/**
 * Customer returns are refunds at the till now, and supplier returns live under Purchasing — two
 * doors into the same list was the confusion the Module 2 test run found. Old links land here.
 */
export default function ReturnsPage() {
  redirect("/purchasing/supplier-returns");
}
