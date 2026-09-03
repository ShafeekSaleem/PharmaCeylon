"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconBox,
  IconDollarSign,
  IconFileText,
  IconPackage,
} from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { usePageChrome } from "@/lib/page-chrome-context";
import { useAuth } from "@/lib/use-auth";
import { hasPermission, usePermissions } from "@/lib/permissions";
import { useProductDetailUrl } from "../hooks/use-product-detail-url";
import { useProductMeta } from "../hooks/use-product-meta";
import { useProductMetaMutations } from "../hooks/use-product-meta-mutations";
import { useProductMutations } from "../hooks/use-product-mutations";
import detailCss from "../product-detail.module.css";
import listCss from "../products.module.css";
import type { ProductDetail, ProductDetailTab } from "../types";
import { hasWriteAccess } from "../utils";
import { productOperationalLinks } from "../utils/product-routes";
import { ConfirmDialog } from "./confirm-dialog";
import { ProductBranchNotice } from "./product-branch-notice";
import { ProductDetailHero } from "./product-detail-hero";
import { ProductDetailHistoryTab } from "./product-detail-history-tab";
import { ProductDetailOverviewTab } from "./product-detail-overview-tab";
import { ProductDetailPricingTab } from "./product-detail-pricing-tab";
import { ProductDetailSidebar } from "./product-detail-sidebar";
import { ProductDetailSkeleton } from "./product-detail-skeleton";
import { ProductDetailStockTab } from "./product-detail-stock-tab";
import { ProductReferenceNotice } from "./product-reference-notice";
import { ProductFormModal } from "./product-form-modal";

const TAB_DEFS: {
  id: ProductDetailTab;
  label: string;
  icon: ReactNode;
  countKey?: keyof Pick<ProductDetail, "batches" | "history"> | "pricing";
}[] = [
  { id: "overview", label: "Overview", icon: <IconPackage size={15} /> },
  { id: "stock", label: "Stock & batches", icon: <IconBox size={15} />, countKey: "batches" },
  { id: "pricing", label: "Pricing", icon: <IconDollarSign size={15} />, countKey: "pricing" },
  { id: "history", label: "History", icon: <IconFileText size={15} />, countKey: "history" },
];

function tabCount(detail: ProductDetail | null, key?: string): number | undefined {
  if (!detail || !key) return undefined;
  if (key === "batches") return detail.batches.length;
  if (key === "history") return detail.history.length;
  if (key === "pricing") return detail.pricing.batchCount;
  return undefined;
}

export function ProductDetailPage({ productId }: { productId: string }) {
  const router = useRouter();
  const { user, branchId } = useAuth();
  const { permissionKeys } = usePermissions();
  const canWrite = hasWriteAccess(user, branchId);
  const canDeleteProduct = hasPermission(permissionKeys, ["products.delete"]);
  const { setLastSegmentLabel, setExtraCrumbs } = usePageChrome();
  const { tab, setTab, returnTo } = useProductDetailUrl(productId);
  const { categories, tags, refresh: refreshMeta } = useProductMeta();
  const metaMutations = useProductMetaMutations(refreshMeta);

  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reloadDetail = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    return apiJson<ProductDetail>(`/products/${productId}/detail`)
      .then(setDetail)
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load product");
      })
      .finally(() => setLoading(false));
  }, [productId]);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setLoading(true);
    void reloadDetail();
  }, [productId, branchId, reloadDetail]);

  const mutations = useProductMutations(() => {
    void reloadDetail();
    refreshMeta();
  });

  const product = detail?.product;
  const navLinks = productOperationalLinks(productId, {
    sku: product?.sku,
    name: product?.name,
  });

  useEffect(() => {
    setExtraCrumbs([]);
    if (product?.name) setLastSegmentLabel(product.name);
    return () => {
      setLastSegmentLabel(null);
      setExtraCrumbs([]);
    };
  }, [product?.name, setExtraCrumbs, setLastSegmentLabel]);

  const handleDelete = useCallback(async () => {
    const ok = await mutations.handleDelete();
    if (ok) router.push(returnTo);
  }, [mutations, router, returnTo]);

  if (loadError && !loading) {
    return (
      <div className={detailCss.page}>
        <Link href={returnTo} className={detailCss.backLink}>
          ← Back to products
        </Link>
        <Alert variant="error">{loadError}</Alert>
      </div>
    );
  }

  if (loading || !product || !detail) {
    return <ProductDetailSkeleton />;
  }

  return (
    <div className={detailCss.page}>
      <Link href={returnTo} className={detailCss.backLink}>
        ← Back to products
      </Link>
      <ProductBranchNotice />
      {product.rangeStatus === "REFERENCE" && (
        <ProductReferenceNotice
          productId={product.id}
          productName={product.name}
          canWrite={canWrite}
          onRanged={() => void reloadDetail()}
        />
      )}

      <div className={detailCss.shell}>
        <div className={detailCss.pageLayout}>
          <div className={detailCss.mainColumn}>
            <ProductDetailHero
              product={product}
              detail={detail}
              canWrite={canWrite}
              canDelete={canDeleteProduct}
              onEdit={() => mutations.openEdit(product)}
              onDelete={() => mutations.openDelete(product)}
              onImageChanged={() => void reloadDetail()}
            />

            <div className={detailCss.tabs} role="tablist">
              {TAB_DEFS.map((t) => {
                const count = tabCount(detail, t.countKey);
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    className={`${detailCss.tab} ${tab === t.id ? detailCss.tabActive : ""}`}
                    onClick={() => setTab(t.id)}
                  >
                    <span className={detailCss.tabIcon}>{t.icon}</span>
                    {t.label}
                    {count != null && count > 0 && (
                      <span className={detailCss.tabCount}>{count}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div
              className={`${detailCss.tabPanel}${
                tab === "overview" ? ` ${detailCss.tabPanelCompact}` : ""
              }`}
              role="tabpanel"
            >
              {tab === "overview" && (
                <ProductDetailOverviewTab
                  product={product}
                  canWrite={canWrite}
                  onEditAssignments={() => mutations.openEdit(product)}
                  onAliasesChanged={() => void reloadDetail()}
                />
              )}
              {tab === "stock" && (
                <ProductDetailStockTab product={product} detail={detail} />
              )}
              {tab === "pricing" && (
                <ProductDetailPricingTab
                  product={product}
                  detail={detail}
                  branchName={detail.branchName}
                />
              )}
              {tab === "history" && (
                <ProductDetailHistoryTab
                  history={detail.history}
                  onSelectTab={setTab}
                />
              )}
            </div>
          </div>

          <ProductDetailSidebar
            activeTab={tab}
            navLinks={navLinks}
            detail={detail}
            product={product}
            productId={productId}
          />
        </div>
      </div>

      <ProductFormModal
        open={mutations.modalOpen}
        canWrite={canWrite}
        editingProduct={mutations.editingProduct}
        form={mutations.form}
        saving={mutations.saving}
        formError={mutations.formError}
        fieldErrors={mutations.fieldErrors}
        categories={categories}
        tags={tags}
        onClose={mutations.closeModal}
        onSave={() => void mutations.handleSave()}
        onFieldChange={mutations.updateField}
        onCreateCategory={canWrite ? metaMutations.createCategory : undefined}
        onCreateTag={canWrite ? metaMutations.createTag : undefined}
        onManageMeta={() =>
          window.open("/settings/catalog/categories", "_blank", "noopener,noreferrer")
        }
        onAliasesChanged={
          mutations.editingProduct
            ? () => {
                void mutations.refreshEditingProduct();
                void reloadDetail();
              }
            : undefined
        }
      />

      <ConfirmDialog
        open={mutations.deleteTarget !== null}
        title="Delete product?"
        confirmLabel="Delete"
        loading={mutations.deleting}
        onCancel={() => {
          if (!mutations.deleting) mutations.setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
      >
        {mutations.deleteError && (
          <Alert variant="error" className={listCss.modalAlert}>
            {mutations.deleteError}
          </Alert>
        )}
        <p>
          Permanently delete <strong>{mutations.deleteTarget?.name}</strong> (
          {mutations.deleteTarget?.sku})?
        </p>
        <p className={listCss.confirmDialogHint}>
          This cannot be undone. Deletion fails if the product is linked to inventory, sales, or
          purchase records. Mark inactive via Edit instead.
        </p>
      </ConfirmDialog>
    </div>
  );
}
