import { redirect } from "next/navigation";

/** Tags moved into Catalog Management as a section. */
export default function TagsRedirect() {
  redirect("/products/manage?section=tags");
}
