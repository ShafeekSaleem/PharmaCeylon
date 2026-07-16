"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { IconPackage, IconX } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import styles from "./product-context-banner.module.css";

type ProductSummary = { id: string; sku: string; name: string };

export function ProductContextBanner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const productId = searchParams.get("productId");
  const [product, setProduct] = useState<ProductSummary | null>(null);

  useEffect(() => {
    if (!productId) {
      setProduct(null);
      return;
    }
    let cancelled = false;
    apiJson<ProductSummary>(`/products/${productId}`)
      .then((p) => {
        if (!cancelled) setProduct(p);
      })
      .catch(() => {
        if (!cancelled) setProduct(null);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (!productId) return null;

  const clearProductFilter = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("productId");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div className={styles.banner} role="status">
      <IconPackage size={18} className={styles.icon} />
      <div className={styles.text}>
        {product ? (
          <>
            <span className={styles.label}>Product context</span>
            <span className={styles.name}>
              {product.name} <span className={styles.sku}>({product.sku})</span>
            </span>
          </>
        ) : (
          <span className={styles.label}>Loading product…</span>
        )}
      </div>
      <div className={styles.actions}>
        <Link href={`/products/${productId}`} className={styles.link}>
          Open product
        </Link>
        <button
          type="button"
          className={styles.clearBtn}
          onClick={clearProductFilter}
          data-tooltip="Clear product filter"
          aria-label="Clear product filter"
        >
          <IconX size={14} />
          Clear
        </button>
      </div>
    </div>
  );
}
