"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { usePermissions } from "@/lib/permissions";
import { Alert } from "@/components/alert";
import type { ImportSummary } from "../types";
import { StockDraftEditor } from "./stock-draft-editor";
import css from "./stock-draft.module.css";

export function OpeningStockDrafts() {
  const { branchId } = useAuth();
  const { permissionKeys } = usePermissions();
  return branchId && permissionKeys.includes("products.import") ? (
    <DraftList
      key={branchId}
      branchId={branchId}
      canEditCosts={permissionKeys.includes("costs.view")}
    />
  ) : null;
}

function DraftList({
  branchId,
  canEditCosts,
}: {
  branchId: string;
  canEditCosts: boolean;
}) {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiJson<ImportSummary[]>("/products/import/history?take=50", {
      headers: { "x-branch-id": branchId },
    })
      .then(
        (rows) => {
          if (!cancelled)
            setImports(
              rows.filter(
                (row) =>
                  row.branchId === branchId &&
                  row.stockStaged &&
                  row.status === "completed",
              ),
            );
        },
        (cause) => {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : "Couldn't load opening-stock drafts.",
            );
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, revision]);
  return (
    <section className={css.panel} aria-label="Recent opening-stock drafts">
      <h2>Opening-stock drafts</h2>
      <p>
        Import a file to stage quantities, batches, prices and expiry dates.
        Review or edit the saved draft before posting at the counter. Staging
        does not make the branch ready for sales.
      </p>
      <Link href="/products/import?mode=stage">
        Import an opening-stock draft
      </Link>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <ul>
        {imports.map((row) => (
          <li key={row.id}>
            <button type="button" onClick={() => setSelected(row.id)}>
              {row.filename} — {row.unitsStaged ?? 0} units waiting
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <StockDraftEditor
          key={`${branchId}:${selected}`}
          branchId={branchId}
          importId={selected}
          canEditCosts={canEditCosts}
          onChanged={() => setRevision((value) => value + 1)}
        />
      ) : loading ? (
        <p>Loading opening-stock drafts…</p>
      ) : !imports.length && !error ? (
        <p>
          No completed opening-stock drafts among the most recent 50 imports.
        </p>
      ) : null}
      <p>
        Once opening stock is posted, plan a first full stocktake a few weeks
        after go-live to compare the shelves with the records.
      </p>
    </section>
  );
}
