"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import listCss from "../products.module.css";
import detailCss from "../product-detail.module.css";
import type { ProductAlias } from "../types";

export function ProductAliasesEditor({
  productId,
  aliases,
  canWrite,
  disabled,
  onChanged,
  variant = "form",
}: {
  productId: string;
  aliases: ProductAlias[];
  canWrite: boolean;
  disabled?: boolean;
  onChanged: () => void;
  /** `detail` = chip row with dashed add button (product overview). */
  variant?: "form" | "detail";
}) {
  const [aliasInput, setAliasInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addAlias = async () => {
    const text = aliasInput.trim();
    if (!text) return;
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/products/${productId}/aliases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aliasText: text, aliasType: "synonym" }),
      });
      setAliasInput("");
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add alias");
    } finally {
      setSaving(false);
    }
  };

  const removeAlias = async (alias: ProductAlias) => {
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/products/${productId}/aliases/${alias.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove alias");
    } finally {
      setSaving(false);
    }
  };

  if (variant === "detail") {
    return (
      <div className={detailCss.aliasChipsBlock}>
        {error && <p className={detailCss.error}>{error}</p>}
        <ul className={detailCss.aliasChipList}>
          {aliases.map((a) => (
            <li key={a.id} className={detailCss.aliasChip}>
              <span>{a.aliasText}</span>
              {canWrite && (
                <button
                  type="button"
                  className={detailCss.aliasChipRemove}
                  onClick={() => void removeAlias(a)}
                  disabled={disabled || saving}
                  aria-label={`Remove ${a.aliasText}`}
                  data-tooltip="Remove alias"
                >
                  <IconX size={12} />
                </button>
              )}
            </li>
          ))}

          {canWrite && !adding && (
            <li>
              <button
                type="button"
                className={detailCss.aliasAddChip}
                onClick={() => setAdding(true)}
                disabled={disabled || saving}
              >
                <IconPlus size={14} />
                Add new
              </button>
            </li>
          )}

          {canWrite && adding && (
            <li className={detailCss.aliasInlineAdd}>
              <input
                type="text"
                className={detailCss.aliasInlineInput}
                placeholder="Alternate name…"
                value={aliasInput}
                autoFocus
                onChange={(e) => setAliasInput(e.target.value)}
                disabled={disabled || saving}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addAlias();
                  }
                  if (e.key === "Escape") {
                    setAdding(false);
                    setAliasInput("");
                  }
                }}
              />
              <button
                type="button"
                className={detailCss.aliasInlineConfirm}
                onClick={() => void addAlias()}
                disabled={disabled || saving || !aliasInput.trim()}
              >
                Add
              </button>
              <button
                type="button"
                className={detailCss.aliasInlineCancel}
                onClick={() => {
                  setAdding(false);
                  setAliasInput("");
                }}
                disabled={saving}
                aria-label="Cancel"
                data-tooltip="Cancel"
              >
                <IconX size={14} />
              </button>
            </li>
          )}
        </ul>

        {aliases.length === 0 && !canWrite && (
          <p className={detailCss.muted}>No aliases yet.</p>
        )}
      </div>
    );
  }

  return (
    <div className={listCss.aliasesBlock}>
      {canWrite && (
        <div className={listCss.aliasAddRow}>
          <input
            type="text"
            className={listCss.aliasInput}
            placeholder="Add synonym or alternate name…"
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            disabled={disabled || saving}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addAlias();
              }
            }}
          />
          <button
            type="button"
            className={listCss.aliasAddBtn}
            onClick={() => void addAlias()}
            disabled={disabled || saving || !aliasInput.trim()}
          >
            <IconPlus size={15} />
            Add new
          </button>
        </div>
      )}
      {error && <p className={listCss.aliasError}>{error}</p>}
      {aliases.length === 0 ? (
        <p className={listCss.aliasEmpty}>No aliases yet.</p>
      ) : (
        <ul className={listCss.aliasChipList}>
          {aliases.map((a) => (
            <li key={a.id} className={listCss.aliasChip}>
              <span>{a.aliasText}</span>
              {canWrite && (
                <button
                  type="button"
                  className={listCss.aliasChipRemove}
                  onClick={() => void removeAlias(a)}
                  disabled={disabled || saving}
                  aria-label={`Remove ${a.aliasText}`}
                  data-tooltip="Remove alias"
                >
                  <IconX size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
