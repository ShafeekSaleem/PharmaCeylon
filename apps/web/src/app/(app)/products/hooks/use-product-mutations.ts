"use client";

import { useCallback, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { INITIAL_FORM } from "../constants";
import type { Product, ProductForm } from "../types";
import { formToBody, productToForm } from "../utils";

export function useProductMutations(onSuccess: () => void) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductForm>(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openCreate = useCallback(() => {
    setEditingProduct(null);
    setForm(INITIAL_FORM);
    setFormError(null);
    setFieldErrors({});
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((product: Product) => {
    setFormError(null);
    setFieldErrors({});
    setModalOpen(true);
    setEditingProduct(product);
    setForm(productToForm(product));
    void apiJson<Product>(`/products/${product.id}`)
      .then((full) => {
        setEditingProduct(full);
        setForm(productToForm(full));
      })
      .catch(() => {});
  }, []);

  const refreshEditingProduct = useCallback(async () => {
    const id = editingProduct?.id;
    if (!id) return;
    try {
      const full = await apiJson<Product>(`/products/${id}`);
      setEditingProduct(full);
    } catch {
      /* keep current row data */
    }
  }, [editingProduct?.id]);

  const closeModal = useCallback(() => {
    if (saving) return;
    setModalOpen(false);
    setEditingProduct(null);
  }, [saving]);

  const updateField = useCallback(<K extends keyof ProductForm>(key: K, value: ProductForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const validate = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (!form.sku.trim()) errors.sku = "SKU is required";
    if (!form.name.trim()) errors.name = "Name is required";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [form]);

  const handleSave = useCallback(async () => {
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
      onSuccess();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [editingProduct, form, onSuccess, validate]);

  const handleDelete = useCallback(async (): Promise<boolean> => {
    if (!deleteTarget) return false;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiJson(`/products/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      onSuccess();
      return true;
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      return false;
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, onSuccess]);

  const openDelete = useCallback((product: Product) => {
    setDeleteError(null);
    setDeleteTarget(product);
  }, []);

  return {
    modalOpen,
    editingProduct,
    form,
    saving,
    formError,
    fieldErrors,
    deleteTarget,
    deleting,
    deleteError,
    openCreate,
    openEdit,
    refreshEditingProduct,
    closeModal,
    updateField,
    handleSave,
    handleDelete,
    openDelete,
    setDeleteTarget,
    setDeleteError,
  };
}
