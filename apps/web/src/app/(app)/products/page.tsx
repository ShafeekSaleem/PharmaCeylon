"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert } from "@/components/alert";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import {
  IconPackage,
  IconPlus,
  IconSearch,
  IconAlertTriangle,
  IconCheck,
  IconActivity,
  IconEdit,
  IconTrash,
  IconSettings,
  IconX,
  IconZoomIn,
} from "@/components/icons";
import {
  DataTable,
  type Column,
  type SortDir,
  FormField,
  Modal,
  ModalFooter,
  ModalButton,
  StatusBadge,
  PageHeader,
  ActionButton,
  StatCard,
  StatGrid,
  ImageUpload,
} from "@/components/ui";
import { apiFetch, apiJson } from "@/lib/auth-client";
import { getBranchId } from "@/lib/auth-session";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { useAuth } from "@/lib/use-auth";
import css from "./products.module.css";
import {
  EMPTY_PRODUCT_FILTERS,
  productFiltersAreActive,
  productFiltersToQueryParams,
  ProductsFilterPanel,
  type FilterFacets,
  type ProductFilters,
} from "./products-filter-panel";

/* ── Types ── */

type Product = {
  id: string;
  tenantId: string;
  sku: string;
  barcode: string | null;
  name: string;
  brandName: string | null;
  genericName: string | null;
  manufacturer: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  imageUrl: string | null;
  isControlled: boolean;
  reorderLevel: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type ProductList = { items: Product[]; total: number; skip: number; take: number };

type FacetEntry = { value: string; count: number };
type ControlledEntry = { value: boolean; count: number };

type SummaryFacets = {
  brands: FacetEntry[];
  dosageForms: FacetEntry[];
  controlled: ControlledEntry[];
  status?: FacetEntry[];
  branchStockSummary: {
    inStockProductCount: number;
    lowStockProductCount: number;
  } | null;
};

type ProductForm = {
  sku: string;
  barcode: string;
  name: string;
  genericName: string;
  brandName: string;
  manufacturer: string;
  dosageForm: string;
  strength: string;
  unit: string;
  imageUrl: string | null;
  reorderLevel: number;
  isControlled: boolean;
  isActive: boolean;
};

type ColumnKey =
  | "image"
  | "sku"
  | "name"
  | "brandName"
  | "dosageForm"
  | "manufacturer"
  | "unit"
  | "reorderLevel"
  | "status"
  | "actions";

/* ── Constants ── */

const PAGE_SIZE = 10;
const COLUMN_STORAGE_KEY = "pc-products-visible-columns";

const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);

const INITIAL_FORM: ProductForm = {
  sku: "",
  barcode: "",
  name: "",
  genericName: "",
  brandName: "",
  manufacturer: "",
  dosageForm: "",
  strength: "",
  unit: "",
  imageUrl: null,
  reorderLevel: 0,
  isControlled: false,
  isActive: true,
};

type StatFilter = "all" | "active" | "controlled" | "lowStock";

const COLUMN_META: { key: ColumnKey; label: string; hideable: boolean }[] = [
  { key: "image", label: "Image", hideable: false },
  { key: "sku", label: "SKU", hideable: true },
  { key: "name", label: "Name", hideable: true },
  { key: "brandName", label: "Brand", hideable: true },
  { key: "dosageForm", label: "Form / Strength", hideable: true },
  { key: "manufacturer", label: "Manufacturer", hideable: true },
  { key: "unit", label: "Unit", hideable: true },
  { key: "reorderLevel", label: "Reorder level", hideable: true },
  { key: "status", label: "Status", hideable: true },
  { key: "actions", label: "Actions", hideable: false },
];

const DEFAULT_VISIBLE = new Set<ColumnKey>([
  "image",
  "sku",
  "name",
  "brandName",
  "dosageForm",
  "reorderLevel",
  "status",
  "actions",
]);

/* ── Helpers ── */

function hasWriteAccess(user: { roles: string[]; branchRoles: { role: string }[] } | null): boolean {
  if (!user) return false;
  if (user.roles.some((r) => WRITE_ROLES.has(r))) return true;
  return user.branchRoles.some((br) => WRITE_ROLES.has(br.role));
}

function formToBody(form: ProductForm, isEdit: boolean) {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    barcode: form.barcode.trim() || null,
    genericName: form.genericName.trim() || null,
    brandName: form.brandName.trim() || null,
    manufacturer: form.manufacturer.trim() || null,
    dosageForm: form.dosageForm.trim() || null,
    strength: form.strength.trim() || null,
    unit: form.unit.trim() || null,
    imageUrl: form.imageUrl || null,
    reorderLevel: form.reorderLevel,
    isControlled: form.isControlled,
  };
  if (!isEdit) {
    body.sku = form.sku.trim();
  } else {
    body.isActive = form.isActive;
  }
  return body;
}

function loadVisibleColumns(): Set<ColumnKey> {
  if (typeof window === "undefined") return new Set(DEFAULT_VISIBLE);
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE);
    const parsed = JSON.parse(raw) as ColumnKey[];
    const next = new Set<ColumnKey>();
    for (const key of parsed) {
      if (COLUMN_META.some((c) => c.key === key)) next.add(key);
    }
    for (const c of COLUMN_META) {
      if (!c.hideable) next.add(c.key);
    }
    return next.size > 0 ? next : new Set(DEFAULT_VISIBLE);
  } catch {
    return new Set(DEFAULT_VISIBLE);
  }
}

/* ── Component ── */

export default function ProductsPage() {
  const { user } = useAuth();
  const canWrite = hasWriteAccess(user);
  const hasBranch = !!getBranchId();

  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [appliedFilters, setAppliedFilters] = useState<ProductFilters>(EMPTY_PRODUCT_FILTERS);
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [activeStatFilter, setActiveStatFilter] = useState<StatFilter | null>(null);

  const [summaryFacets, setSummaryFacets] = useState<SummaryFacets | null>(null);
  const [filterFacets, setFilterFacets] = useState<FilterFacets | null>(null);
  const [totalAll, setTotalAll] = useState<number | null>(null);

  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(DEFAULT_VISIBLE);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);

  const [viewProduct, setViewProduct] = useState<Product | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductForm>(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const filtersActive = productFiltersAreActive(appliedFilters);

  const resetPage = () => setPage(1);

  useEffect(() => {
    setVisibleColumns(loadVisibleColumns());
  }, []);

  useEffect(() => {
    if (!columnsOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (columnsRef.current && !columnsRef.current.contains(target)) {
        setColumnsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [columnsOpen]);

  useBodyScrollLock(!!viewProduct);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const fetchProducts = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);

    const skip = (page - 1) * PAGE_SIZE;
    const filterParams = productFiltersToQueryParams(appliedFilters);
    const params = new URLSearchParams({
      skip: String(skip),
      take: String(PAGE_SIZE),
      status: filterParams.status,
      sortBy,
      sortDir,
    });
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (filterParams.dosageForm) params.set("dosageForm", filterParams.dosageForm);
    if (filterParams.brandName) params.set("brandName", filterParams.brandName);
    if (filterParams.isControlled) params.set("isControlled", filterParams.isControlled);
    if (filterParams.lowStock) params.set("lowStock", "true");

    apiJson<ProductList>(`/products?${params}`)
      .then((data) => {
        if (!cancelled) {
          setProducts(data.items);
          setTotal(data.total);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : "Failed to load products");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [
    page,
    debouncedSearch,
    appliedFilters,
    sortBy,
    sortDir,
  ]);

  useEffect(() => fetchProducts(), [fetchProducts]);

  const buildFacetsQuery = useCallback(
    (filters: ProductFilters, search: string) => {
      const filterParams = productFiltersToQueryParams(filters);
      const params = new URLSearchParams({ status: filterParams.status });
      if (search) params.set("q", search);
      if (filterParams.dosageForm) params.set("dosageForm", filterParams.dosageForm);
      if (filterParams.brandName) params.set("brandName", filterParams.brandName);
      if (filterParams.isControlled) params.set("isControlled", filterParams.isControlled);
      if (filterParams.lowStock) params.set("lowStock", "true");
      return params;
    },
    [],
  );

  const fetchFilterFacets = useCallback(() => {
    const params = buildFacetsQuery(appliedFilters, debouncedSearch);
    apiJson<FilterFacets>(`/catalog/facets?${params}`)
      .then(setFilterFacets)
      .catch(() => {});
  }, [appliedFilters, debouncedSearch, buildFacetsQuery]);

  const refreshStats = useCallback(() => {
    apiJson<SummaryFacets>("/catalog/facets?status=all")
      .then(setSummaryFacets)
      .catch(() => {});
    apiJson<ProductList>("/products?take=0&status=all")
      .then((d) => setTotalAll(d.total))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    fetchFilterFacets();
  }, [fetchFilterFacets]);

  const controlledCount = useMemo(() => {
    const entry = summaryFacets?.controlled.find((c) => c.value === true);
    return entry?.count ?? 0;
  }, [summaryFacets]);

  const activeCount = useMemo(() => {
    const entry = summaryFacets?.status?.find((s) => s.value === "active");
    if (entry) return entry.count;
    return summaryFacets?.controlled.reduce((sum, c) => sum + c.count, 0) ?? total;
  }, [summaryFacets, total]);

  const lowStock = summaryFacets?.branchStockSummary?.lowStockProductCount;

  const openCreate = () => {
    setEditingProduct(null);
    setForm(INITIAL_FORM);
    setFormError(null);
    setFieldErrors({});
    setModalOpen(true);
  };

  const openEdit = useCallback((product: Product) => {
    setEditingProduct(product);
    setForm({
      sku: product.sku,
      barcode: product.barcode ?? "",
      name: product.name,
      genericName: product.genericName ?? "",
      brandName: product.brandName ?? "",
      manufacturer: product.manufacturer ?? "",
      dosageForm: product.dosageForm ?? "",
      strength: product.strength ?? "",
      unit: product.unit ?? "",
      imageUrl: product.imageUrl,
      reorderLevel: product.reorderLevel,
      isControlled: product.isControlled,
      isActive: product.isActive,
    });
    setFormError(null);
    setFieldErrors({});
    setModalOpen(true);
  }, []);

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setEditingProduct(null);
  };

  const updateField = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!form.sku.trim()) errors.sku = "SKU is required";
    if (!form.name.trim()) errors.name = "Name is required";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    setFormError(null);
    const isEdit = editingProduct !== null;
    const body = formToBody(form, isEdit);

    try {
      if (isEdit) {
        await apiJson(`/products/${editingProduct.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await apiJson("/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      setModalOpen(false);
      setEditingProduct(null);
      fetchProducts();
      refreshStats();
      fetchFilterFacets();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiJson(`/products/${deleteTarget.id}`, { method: "DELETE" });
      if (viewProduct?.id === deleteTarget.id) setViewProduct(null);
      setDeleteTarget(null);
      fetchProducts();
      refreshStats();
      fetchFilterFacets();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const applyStatFilter = (filter: StatFilter) => {
    setActiveStatFilter(filter);
    if (filter === "all") {
      setAppliedFilters(EMPTY_PRODUCT_FILTERS);
    } else if (filter === "active") {
      setAppliedFilters({
        ...EMPTY_PRODUCT_FILTERS,
        status: ["active"],
      });
    } else if (filter === "controlled") {
      setAppliedFilters({
        ...EMPTY_PRODUCT_FILTERS,
        controlled: ["true"],
      });
    } else if (filter === "lowStock") {
      setAppliedFilters({
        ...EMPTY_PRODUCT_FILTERS,
        lowStock: true,
      });
    }
    resetPage();
  };

  const clearFilters = () => {
    setAppliedFilters(EMPTY_PRODUCT_FILTERS);
    setActiveStatFilter(null);
    resetPage();
  };

  const handleFiltersApply = (filters: ProductFilters) => {
    setAppliedFilters(filters);
    setActiveStatFilter(null);
    resetPage();
  };

  const toggleStatFilter = (filter: StatFilter) => {
    if (activeStatFilter === filter) {
      clearFilters();
      return;
    }
    applyStatFilter(filter);
  };

  const toggleColumn = (key: ColumnKey) => {
    const meta = COLUMN_META.find((c) => c.key === key);
    if (!meta?.hideable) return;
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      for (const c of COLUMN_META) {
        if (!c.hideable) next.add(c.key);
      }
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const handleServerSort = useCallback((key: string, dir: SortDir) => {
    setSortBy(key);
    setSortDir(dir);
    resetPage();
  }, []);

  const allColumnDefs: Column<Product>[] = useMemo(
    () => [
      {
        key: "image",
        header: "",
        width: "56px",
        render: (row) => <ProductThumb row={row} />,
      },
      {
        key: "sku",
        header: "SKU",
        sortable: true,
        width: "120px",
        getValue: (row) => row.sku,
      },
      {
        key: "name",
        header: "Name",
        sortable: true,
        getValue: (row) => row.name,
        render: (row) => (
          <div className={css.nameCell}>
            <span>{row.name}</span>
            {row.genericName && row.genericName !== row.name && (
              <span className={css.genericName}>{row.genericName}</span>
            )}
          </div>
        ),
      },
      {
        key: "brandName",
        header: "Brand",
        sortable: true,
        getValue: (row) => row.brandName ?? "",
        render: (row) => <>{row.brandName ?? "—"}</>,
      },
      {
        key: "dosageForm",
        header: "Form / Strength",
        getValue: (row) => row.dosageForm ?? "",
        render: (row) => (
          <>
            {row.dosageForm ?? "—"}
            {row.strength ? ` · ${row.strength}` : ""}
          </>
        ),
      },
      {
        key: "manufacturer",
        header: "Manufacturer",
        getValue: (row) => row.manufacturer ?? "",
        render: (row) => <>{row.manufacturer ?? "—"}</>,
      },
      {
        key: "unit",
        header: "Unit",
        width: "90px",
        getValue: (row) => row.unit ?? "",
        render: (row) => <>{row.unit ?? "—"}</>,
      },
      {
        key: "reorderLevel",
        header: "Reorder Lvl",
        align: "right",
        width: "110px",
        sortable: true,
        getValue: (row) => row.reorderLevel,
        render: (row) => <>{row.reorderLevel}</>,
      },
      {
        key: "status",
        header: "Status",
        width: "160px",
        render: (row) => (
          <div className={css.statusCell}>
            <StatusBadge status={row.isActive ? "active" : "inactive"} dot />
            {row.isControlled && (
              <span className={css.controlledTag}>
                <IconAlertTriangle size={11} />
                Ctrl
              </span>
            )}
          </div>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        width: "72px",
        align: "right",
        render: (row) =>
          canWrite ? (
            <ProductActions
              row={row}
              onEdit={openEdit}
              onDelete={(p) => {
                setDeleteError(null);
                setDeleteTarget(p);
              }}
            />
          ) : null,
      },
    ],
    [canWrite, openEdit],
  );

  const columns = useMemo(
    () => allColumnDefs.filter((col) => visibleColumns.has(col.key as ColumnKey)),
    [allColumnDefs, visibleColumns],
  );

  return (
    <>
      <PageHeader
        subtitleOnly
        description="Manage your pharmacy product catalog"
        actions={
          canWrite ? (
            <ActionButton icon={<IconPlus size={16} />} onClick={openCreate}>
              Add Product
            </ActionButton>
          ) : undefined
        }
      />

      <div className={css.statsSection}>
        <StatGrid columns={4}>
          <StatCard
            title="Total Products"
            value={totalAll ?? "…"}
            icon={<IconPackage size={20} />}
            iconTone="primary"
            active={activeStatFilter === "all"}
            onClick={() => toggleStatFilter("all")}
          />
          <StatCard
            title="Active Products"
            value={summaryFacets ? activeCount : "…"}
            icon={<IconCheck size={20} />}
            iconTone="success"
            active={activeStatFilter === "active"}
            onClick={() => toggleStatFilter("active")}
          />
          <StatCard
            title="Controlled Substances"
            value={controlledCount}
            icon={<IconAlertTriangle size={20} />}
            iconTone="warning"
            active={activeStatFilter === "controlled"}
            onClick={() => toggleStatFilter("controlled")}
          />
          <StatCard
            title="Low Stock"
            value={lowStock ?? "—"}
            icon={<IconActivity size={20} />}
            iconTone="danger"
            active={activeStatFilter === "lowStock"}
            onClick={() => hasBranch && toggleStatFilter("lowStock")}
          />
        </StatGrid>
      </div>

      <div className={css.toolbar}>
        <div className={css.toolbarGroup}>
          <ProductsFilterPanel
            facets={filterFacets}
            applied={appliedFilters}
            onApply={handleFiltersApply}
          />
          <div className={css.searchWrap}>
            <span className={css.searchIcon}>
              <IconSearch size={16} />
            </span>
            <input
              className={css.searchInput}
              type="text"
              placeholder="Search products…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className={css.clearBtnSlot}>
            <button
              type="button"
              className={`${css.clearBtn} ${!filtersActive ? css.clearBtnHidden : ""}`}
              onClick={clearFilters}
              disabled={!filtersActive}
              tabIndex={filtersActive ? 0 : -1}
            >
              Clear filters
            </button>
          </div>
        </div>

        <div className={css.toolbarActions}>
          <div className={css.columnsWrap} ref={columnsRef}>
            <button
              type="button"
              className={css.columnsBtn}
              onClick={() => setColumnsOpen((o) => !o)}
              aria-expanded={columnsOpen}
            >
              <IconSettings size={15} />
              Columns
            </button>
            {columnsOpen && (
              <div className={css.columnsPopover}>
                <div className={css.columnsPopoverTitle}>Show columns</div>
                {COLUMN_META.filter((c) => c.hideable).map((col) => (
                  <label key={col.key} className={css.columnOption}>
                    <input
                      type="checkbox"
                      checked={visibleColumns.has(col.key)}
                      onChange={() => toggleColumn(col.key)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {listError && (
        <Alert variant="error" style={{ marginBottom: "1rem" }}>
          {listError}
        </Alert>
      )}

      <DataTable<Product>
        columns={columns}
        data={products}
        rowKey={(r) => r.id}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        sortKey={sortBy}
        sortDir={sortDir}
        onSort={handleServerSort}
        onRowClick={(row) => setViewProduct(row)}
        emptyTitle="No products found"
        emptyDescription="Try adjusting your search or filters"
        emptyIcon={<IconPackage size={48} />}
      />

      {viewProduct && (
        <ProductDetailOverlay
          product={viewProduct}
          canWrite={canWrite}
          onClose={() => setViewProduct(null)}
          onEdit={(p) => {
            setViewProduct(null);
            openEdit(p);
          }}
          onDelete={(p) => {
            setDeleteError(null);
            setDeleteTarget(p);
          }}
          onImageUpdated={(updated) => {
            setViewProduct(updated);
            setProducts((prev) =>
              prev.map((p) => (p.id === updated.id ? updated : p)),
            );
          }}
        />
      )}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editingProduct ? "Edit Product" : "Add Product"}
        size="lg"
        footer={
          <ModalFooter>
            <ModalButton variant="secondary" onClick={closeModal}>
              Cancel
            </ModalButton>
            <ModalButton variant="primary" onClick={handleSave} loading={saving}>
              Save
            </ModalButton>
          </ModalFooter>
        }
      >
        {formError && (
          <Alert variant="error" className={css.modalAlert}>
            {formError}
          </Alert>
        )}

        <h3 className={css.sectionTitle}>Basic Info</h3>
        <div className={css.basicGrid}>
          <div className={css.imageCol}>
            <ImageUpload
              value={form.imageUrl}
              onChange={(url) => updateField("imageUrl", url)}
              folder="products"
              disabled={saving}
            />
          </div>
          <div className={css.fieldsCol}>
            <FormField
              label="SKU"
              required
              value={form.sku}
              onChange={(e) => updateField("sku", (e.target as HTMLInputElement).value)}
              error={fieldErrors.sku}
              disabled={!!editingProduct || saving}
              placeholder="e.g. PARA-500"
            />
            <FormField
              label="Barcode"
              value={form.barcode}
              onChange={(e) => updateField("barcode", (e.target as HTMLInputElement).value)}
              disabled={saving}
              placeholder="Optional"
            />
            <FormField
              label="Name"
              required
              value={form.name}
              onChange={(e) => updateField("name", (e.target as HTMLInputElement).value)}
              error={fieldErrors.name}
              disabled={saving}
              placeholder="Product name"
            />
            <FormField
              label="Generic Name"
              value={form.genericName}
              onChange={(e) => updateField("genericName", (e.target as HTMLInputElement).value)}
              disabled={saving}
              placeholder="Optional"
            />
          </div>
        </div>

        <h3 className={css.sectionTitle}>Classification</h3>
        <div className={css.twoCol}>
          <FormField
            label="Brand"
            value={form.brandName}
            onChange={(e) => updateField("brandName", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="Brand name"
          />
          <FormField
            label="Manufacturer"
            value={form.manufacturer}
            onChange={(e) => updateField("manufacturer", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="Manufacturer"
          />
          <FormField
            label="Dosage Form"
            value={form.dosageForm}
            onChange={(e) => updateField("dosageForm", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="e.g. Tablet, Capsule"
          />
          <FormField
            label="Strength"
            value={form.strength}
            onChange={(e) => updateField("strength", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="e.g. 500mg"
          />
          <FormField
            label="Unit"
            value={form.unit}
            onChange={(e) => updateField("unit", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="e.g. Strip, Bottle"
          />
        </div>

        <h3 className={css.sectionTitle}>Inventory &amp; Compliance</h3>
        <div className={css.twoCol}>
          <FormField
            label="Reorder Level"
            type="number"
            value={String(form.reorderLevel)}
            onChange={(e) =>
              updateField("reorderLevel", Math.max(0, parseInt((e.target as HTMLInputElement).value) || 0))
            }
            disabled={saving}
          />
          <div />
        </div>
        <div className={css.checkRow}>
          <label className={css.checkLabel}>
            <input
              type="checkbox"
              checked={form.isControlled}
              onChange={(e) => updateField("isControlled", e.target.checked)}
              disabled={saving}
            />
            Controlled Substance
          </label>
          {editingProduct && (
            <label className={css.checkLabel}>
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => updateField("isActive", e.target.checked)}
                disabled={saving}
              />
              Active
            </label>
          )}
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        title="Delete product"
        size="sm"
        footer={
          <ModalFooter>
            <ModalButton variant="secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </ModalButton>
            <ModalButton variant="danger" onClick={handleDelete} loading={deleting}>
              Delete
            </ModalButton>
          </ModalFooter>
        }
      >
        {deleteError && <Alert variant="error" className={css.modalAlert}>{deleteError}</Alert>}
        <p className={css.deleteText}>
          Permanently delete <strong>{deleteTarget?.name}</strong> ({deleteTarget?.sku})?
        </p>
        <p className={css.deleteHint}>
          This cannot be undone. Deletion fails if the product is linked to inventory, sales, or purchase records. Mark inactive via Edit instead.
        </p>
      </Modal>
    </>
  );
}

function ProductThumb({ row }: { row: Product }) {
  const src = row.imageUrl ?? PRODUCT_PLACEHOLDER_SRC;
  return (
    <div className={css.thumbCell}>
      <img
        src={src}
        alt={row.imageUrl ? row.name : ""}
        className={row.imageUrl ? css.thumb : `${css.thumb} ${css.thumbPlaceholder}`}
        aria-hidden={!row.imageUrl}
      />
    </div>
  );
}

function ProductActions({
  row,
  onEdit,
  onDelete,
}: {
  row: Product;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
}) {
  return (
    <div className={css.actionsCell} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`${css.actionIcon} ${css.actionIconEdit}`}
        aria-label={`Edit ${row.name}`}
        onClick={() => onEdit(row)}
      >
        <IconEdit size={17} />
      </button>
      <button
        type="button"
        className={`${css.actionIcon} ${css.actionIconDelete}`}
        aria-label={`Delete ${row.name}`}
        onClick={() => onDelete(row)}
      >
        <IconTrash size={17} />
      </button>
    </div>
  );
}

const PRODUCT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function ProductDetailOverlay({
  product,
  canWrite,
  onClose,
  onEdit,
  onImageUpdated,
}: {
  product: Product;
  canWrite: boolean;
  onClose: () => void;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
  onImageUpdated: (p: Product) => void;
}) {
  const [imageZoomed, setImageZoomed] = useState(false);
  const [savingImage, setSavingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageZoomedRef = useRef(imageZoomed);
  const onCloseRef = useRef(onClose);
  imageZoomedRef.current = imageZoomed;
  onCloseRef.current = onClose;

  const showQuickAddImage = canWrite && !product.imageUrl;

  const handleQuickImage = async (file: File) => {
    if (!PRODUCT_IMAGE_TYPES.includes(file.type)) {
      setImageError("Only JPEG, PNG, or WebP images are allowed.");
      return;
    }
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
      setImageError("File must be under 2 MB.");
      return;
    }

    setImageError(null);
    setSavingImage(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await apiFetch("/uploads/image?context=products", {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => null);
        throw new Error(body?.message || `Upload failed (${uploadRes.status})`);
      }
      const { url } = (await uploadRes.json()) as { url: string };
      const updated = await apiJson<Product>(`/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      });
      onImageUpdated(updated);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Failed to add image.");
    } finally {
      setSavingImage(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (imageZoomedRef.current) setImageZoomed(false);
      else onCloseRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={css.viewBackdrop} role="presentation" onClick={onClose}>
      <div
        className={css.viewCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-view-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={css.viewTop}>
            <div className={css.viewHeaderText}>
              <h2 id="product-view-title" className={css.viewTitle}>
                {product.name}
              </h2>
              {product.genericName && (
                <p className={css.viewGeneric}>{product.genericName}</p>
              )}
              <div className={css.viewBadges}>
                <StatusBadge status={product.isActive ? "active" : "inactive"} dot />
                {product.isControlled && (
                  <span className={css.controlledTag}>
                    <IconAlertTriangle size={11} />
                    Controlled
                  </span>
                )}
              </div>
            </div>
            <div className={css.viewHeaderActions}>
              {canWrite && (
                <button
                  type="button"
                  className={`${css.viewHeaderBtn} ${css.viewHeaderBtnPrimary}`}
                  onClick={() => onEdit(product)}
                  aria-label={`Edit ${product.name}`}
                >
                  <IconEdit size={16} />
                </button>
              )}
              <button
                type="button"
                className={`${css.viewHeaderBtn} ${css.viewHeaderBtnMuted}`}
                onClick={onClose}
                aria-label="Close"
              >
                <IconX size={16} />
              </button>
            </div>
        </header>

        <div className={css.viewBody}>
          <div className={css.viewLeft}>
            <div className={css.viewImageWrap}>
              <div className={css.viewImageFrame}>
                <img
                  src={product.imageUrl ?? PRODUCT_PLACEHOLDER_SRC}
                  alt={product.imageUrl ? product.name : ""}
                  className={
                    product.imageUrl
                      ? css.viewImage
                      : `${css.viewImage} ${css.viewImagePlaceholder}`
                  }
                  aria-hidden={!product.imageUrl}
                />
                {savingImage && (
                  <div className={css.viewImageBusy} aria-live="polite">
                    <span className={css.viewImageSpinner} />
                    <span className={css.viewImageBusyText}>Uploading…</span>
                  </div>
                )}
                {showQuickAddImage && !savingImage && (
                  <>
                    <button
                      type="button"
                      className={css.viewImageAddBtn}
                      onClick={() => imageInputRef.current?.click()}
                      aria-label={`Add image for ${product.name}`}
                    >
                      <IconPlus size={18} />
                      Add image
                    </button>
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className={css.viewImageFileInput}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleQuickImage(file);
                      }}
                    />
                  </>
                )}
                {product.imageUrl && (
                  <button
                    type="button"
                    className={css.viewZoomBtn}
                    onClick={() => setImageZoomed(true)}
                    aria-label="View larger image"
                  >
                    <IconZoomIn size={16} />
                  </button>
                )}
                {imageError && (
                  <p className={css.viewImageError} role="alert">
                    {imageError}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className={css.viewDetails}>
            <section className={css.viewSection} aria-labelledby="product-basic-heading">
            <h3 id="product-basic-heading" className={css.viewSectionTitle}>
              Basic Information
            </h3>
            <div className={css.viewFieldGrid}>
              <ViewField label="SKU" value={product.sku} />
              <ViewField label="Barcode" value={product.barcode} />
              <ViewField label="Brand" value={product.brandName} />
              <ViewField label="Manufacturer" value={product.manufacturer} />
            </div>
          </section>

          <section className={css.viewSection} aria-labelledby="product-spec-heading">
            <h3 id="product-spec-heading" className={css.viewSectionTitle}>
              Specifications
            </h3>
            <div className={css.viewFieldGrid}>
              <ViewField label="Dosage Form" value={product.dosageForm} />
              <ViewField label="Strength" value={product.strength} />
              <ViewField label="Unit" value={product.unit} />
              <ViewField label="Reorder Level" value={product.reorderLevel} />
            </div>
          </section>
          </div>
        </div>
      </div>

      {imageZoomed && product.imageUrl && (
        <div
          className={css.imageZoomBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={`${product.name} image`}
          onClick={() => setImageZoomed(false)}
        >
          <button
            type="button"
            className={`${css.viewHeaderBtn} ${css.viewHeaderBtnMuted} ${css.imageZoomClose}`}
            onClick={() => setImageZoomed(false)}
            aria-label="Close image preview"
          >
            <IconX size={16} />
          </button>
          <img
            src={product.imageUrl}
            alt={product.name}
            className={css.imageZoomImg}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function ViewField({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  const display =
    value === null || value === undefined || value === ""
      ? "—"
      : String(value);
  return (
    <div className={css.viewField}>
      <span className={css.viewFieldLabel}>{label}</span>
      <span className={css.viewFieldValue}>{display}</span>
    </div>
  );
}

