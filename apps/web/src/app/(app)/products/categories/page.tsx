import { redirect } from "next/navigation";

/** Categories moved into Catalog Management as a section. */
export default function CategoriesRedirect() {
  redirect("/products/manage?section=categories");
}
