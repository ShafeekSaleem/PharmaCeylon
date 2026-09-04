import { redirect } from "next/navigation";

/**
 * Search Catalog is now Products → Reference catalog.
 *
 * There were two searches over the same reference rows, with different filters, different
 * result vocabulary and different actions — and only one of them could actually add a medicine
 * to the pharmacy's range, which is what someone searching the register is nearly always
 * trying to do. The Reference tab absorbed the search (name, brand, generic, registration
 * number, barcode and alias, with the same exact/generic/alias/partial indicators) and keeps
 * the Add action beside each result.
 *
 * Kept as a redirect rather than deleted: this path is in bookmarks, in the product detail
 * page's "Search catalog" deep link, and in whatever anyone has shared. Note this is a real
 * redirect and not a rewrite, so the address bar tells the user where the screen went.
 *
 * `?productId=` is preserved as a search term-free deep link into the same product's detail
 * page, which is where the old query parameter led.
 */
export default async function CatalogRedirect({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string; q?: string }>;
}) {
  const params = await searchParams;
  if (params.productId) {
    redirect(`/products/${params.productId}`);
  }
  const query = new URLSearchParams({ scope: "reference" });
  if (params.q?.trim()) query.set("q", params.q.trim());
  redirect(`/products?${query.toString()}`);
}
