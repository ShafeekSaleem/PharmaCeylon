import { redirect } from "next/navigation";

/**
 * Categories and tags moved to the Products section — they are catalog data, not
 * configuration, and the Settings shell cost them a third of the width to a second nav rail.
 * They have since moved again, into Catalog Management — this points at the final
 * destination rather than chaining through the intermediate one.
 */
export default function MovedToProducts() {
  redirect("/products/manage?section=categories");
}
