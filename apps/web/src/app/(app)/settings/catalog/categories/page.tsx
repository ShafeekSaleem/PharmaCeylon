import { redirect } from "next/navigation";

/**
 * Categories and tags moved to the Products section — they are catalog data, not
 * configuration, and the Settings shell cost them a third of the width to a second nav rail.
 * Kept as a redirect so bookmarks and the older in-app links still land somewhere.
 */
export default function MovedToProducts() {
  redirect("/products/categories");
}
