"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ProductDetailTab } from "../types";
import { sanitizeReturnPath } from "../utils/product-routes";

const VALID_TABS = new Set<ProductDetailTab>(["overview", "stock", "pricing", "history"]);

export function useProductDetailUrl(productId: string) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get("tab");
  const tab: ProductDetailTab = VALID_TABS.has(tabParam as ProductDetailTab)
    ? (tabParam as ProductDetailTab)
    : "overview";
  const returnTo = sanitizeReturnPath(searchParams.get("return"));

  const setTab = useCallback(
    (next: ProductDetailTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "overview") params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return { tab, setTab, returnTo, productId };
}
