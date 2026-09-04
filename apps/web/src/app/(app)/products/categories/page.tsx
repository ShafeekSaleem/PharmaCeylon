"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus, IconSearch } from "@/components/icons";
import { ActionButton, PageHeader } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { usePageChrome } from "@/lib/page-chrome-context";
import { ConfirmDialog } from "../components/confirm-dialog";
import {
  applyOnboardingSelection,
  createCategory,
  deleteCategory,
  fetchCommercialTree,
  fetchOnboardingStatus,
  fetchProductIdsInCategory,
  moveProductsCategory,
  reorderCategories,
  updateCategory,
} from "./api";
import { CategoryFormModal, type CategoryModalState } from "./components/category-form-modal";
import { CategoryTree } from "./components/category-tree";
import { MoveProductsModal } from "./components/move-products-modal";
import { OnboardingPanel } from "./components/onboarding-panel";
import { CatalogTabs } from "../components/catalog-tabs";
import css from "./categories.module.css";
import type { CommercialCategoryNode, OnboardingGroupStatus } from "./types";

export default function CatalogCategoriesPage() {
  const { permissionKeys } = usePermissions();
  const { setLastSegmentLabel } = usePageChrome();

  // Without this the breadcrumb reads the raw path segment, "categories".
  useEffect(() => {
    setLastSegmentLabel("Categories");
    return () => setLastSegmentLabel(null);
  }, [setLastSegmentLabel]);
  const canWrite = permissionKeys.includes("product_meta.manage");
  const canDelete = permissionKeys.includes("product_meta.delete");

  const [tree, setTree] = useState<CommercialCategoryNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [onboarding, setOnboarding] = useState<OnboardingGroupStatus[] | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingSaving, setOnboardingSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<CommercialCategoryNode | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [disableWarning, setDisableWarning] = useState<CommercialCategoryNode | null>(null);

  const [moveSource, setMoveSource] = useState<CommercialCategoryNode | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const [categoryModal, setCategoryModal] = useState<CategoryModalState | null>(null);
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [treeData, onboardingData] = await Promise.all([
        fetchCommercialTree(),
        fetchOnboardingStatus(),
      ]);
      setTree(treeData);
      setOnboarding(onboardingData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load categories");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Show the onboarding panel until any department beyond Medicines is enabled.
  const needsOnboarding = useMemo(() => {
    if (!onboarding) return false;
    return !onboarding.some((g) => g.label !== "Medicines" && g.enabled);
  }, [onboarding]);

  async function handleToggleActive(node: CommercialCategoryNode) {
    if (node.isActive && node.productCount > 0) {
      setDisableWarning(node);
      return;
    }
    await applyToggle(node);
  }

  async function applyToggle(node: CommercialCategoryNode) {
    setBusyId(node.id);
    try {
      await updateCategory(node.id, { isActive: !node.isActive });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update category");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCategoryModalSubmit(name: string) {
    if (!categoryModal) return;
    setCategorySaving(true);
    setCategoryError(null);
    try {
      if (categoryModal.mode === "rename") {
        await updateCategory(categoryModal.node.id, { name });
      } else {
        await createCategory(name, categoryModal.parent?.id ?? null);
      }
      await load();
      setCategoryModal(null);
    } catch (err) {
      setCategoryError(
        err instanceof Error
          ? err.message
          : categoryModal.mode === "rename"
            ? "Failed to rename category"
            : "Failed to create category",
      );
    } finally {
      setCategorySaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCategory(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete category");
    } finally {
      setDeleting(false);
    }
  }

  async function handleMove(node: CommercialCategoryNode, direction: "up" | "down", siblings: CommercialCategoryNode[]) {
    const idx = siblings.findIndex((s) => s.id === node.id);
    const swapWith = direction === "up" ? siblings[idx - 1] : siblings[idx + 1];
    if (!swapWith) return;
    setBusyId(node.id);
    try {
      await reorderCategories([
        { id: node.id, sortOrder: swapWith.sortOrder },
        { id: swapWith.id, sortOrder: node.sortOrder },
      ]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder categories");
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmMoveProducts(targetCategoryId: string) {
    if (!moveSource) return;
    setMoveLoading(true);
    setMoveError(null);
    try {
      const productIds = await fetchProductIdsInCategory(moveSource.id);
      if (productIds.length > 0) {
        await moveProductsCategory(productIds, targetCategoryId);
      }
      setMoveSource(null);
      await load();
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : "Failed to move products");
    } finally {
      setMoveLoading(false);
    }
  }

  async function handleSaveOnboarding(selectedLabels: string[]) {
    setOnboardingSaving(true);
    try {
      const status = await applyOnboardingSelection(selectedLabels);
      setOnboarding(status);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save department selection");
    } finally {
      setOnboardingSaving(false);
    }
  }

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="How your products are grouped for the shop floor and for reporting."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              onClick={() => {
                setCategoryError(null);
                setCategoryModal({ mode: "create", parent: null });
              }}
            >
              New Category
            </ActionButton>
          ) : undefined
        }
      />

      <CatalogTabs active="categories" />

      <p className={css.hint}>
        These are merchandising categories. Dosage form, NMRA schedule and registration type
        come from the register and aren&apos;t edited here.
      </p>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {!loading && onboarding && needsOnboarding && !onboardingDismissed ? (
        <OnboardingPanel
          groups={onboarding}
          saving={onboardingSaving}
          onSave={handleSaveOnboarding}
          onDismiss={() => setOnboardingDismissed(true)}
        />
      ) : null}

      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <IconSearch size={15} className={css.searchIcon} />
          <input
            className={css.searchInput}
            placeholder="Search categories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!canWrite ? (
          <span className={css.count}>You have read-only access to categories.</span>
        ) : null}
      </div>

      {loading ? (
        <div className={css.treeCard}>
          <div className={css.treeEmpty}>Loading…</div>
        </div>
      ) : (
        <CategoryTree
          nodes={tree}
          query={query}
          canWrite={canWrite}
          canDelete={canDelete}
          busyId={busyId}
          onToggleActive={handleToggleActive}
          onRequestRename={(node) => {
            setCategoryError(null);
            setCategoryModal({ mode: "rename", node });
          }}
          onRequestAddChild={(parent) => {
            setCategoryError(null);
            setCategoryModal({ mode: "create", parent });
          }}
          onDelete={(node) => {
            setDeleteError(null);
            setDeleteTarget(node);
          }}
          onMove={handleMove}
          onMoveProducts={(node) => {
            setMoveError(null);
            setMoveSource(node);
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this category?"
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
      >
        {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}
        <p>
          Permanently delete <strong>{deleteTarget?.name}</strong>? Only empty, custom categories
          with no subcategories can be deleted — everything else must be disabled instead.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={disableWarning !== null}
        title="Disable this category?"
        confirmLabel="Disable"
        variant="primary"
        onCancel={() => setDisableWarning(null)}
        onConfirm={() => {
          if (disableWarning) void applyToggle(disableWarning);
          setDisableWarning(null);
        }}
      >
        <p>
          <strong>{disableWarning?.name}</strong> has {disableWarning?.productCount} product
          {disableWarning?.productCount === 1 ? "" : "s"} assigned. Disabling it hides it from the
          Products filter, POS, and onboarding — existing product assignments and historical sales
          are kept intact and nothing is deleted. You can re-enable it any time.
        </p>
      </ConfirmDialog>

      <MoveProductsModal
        open={moveSource !== null}
        source={moveSource}
        tree={tree}
        loading={moveLoading}
        error={moveError}
        onClose={() => setMoveSource(null)}
        onConfirm={(targetId) => void handleConfirmMoveProducts(targetId)}
      />

      <CategoryFormModal
        state={categoryModal}
        saving={categorySaving}
        error={categoryError}
        onClose={() => setCategoryModal(null)}
        onSubmit={(name) => void handleCategoryModalSubmit(name)}
      />
    </div>
  );
}
