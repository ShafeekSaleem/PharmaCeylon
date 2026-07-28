"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSearch } from "@/components/icons";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import css from "../../purchasing/purchasing.module.css";
import type { StocktakeListItem } from "../types";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatSigned,
  movementModeLabel,
  scopeLabel,
  statusLabel,
  stocktakeHref,
} from "../utils";
import { StocktakeTablePager } from "./stocktake-table-pager";
import scss from "../stocktakes.module.css";

const PREVIEW_PAGE_SIZE = 5;

type Props = {
  open: boolean;
  stocktake: StocktakeListItem | null;
  onClose: () => void;
};

export function StocktakeSummaryDrawer({ open, stocktake, onClose }: Props) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setPage(1);
      setQuery("");
    }
  }, [open, stocktake?.id]);

  const filteredLines = useMemo(() => {
    if (!stocktake) return [];
    const q = query.trim().toLowerCase();
    if (!q) return stocktake.lines;
    return stocktake.lines.filter((line) =>
      `${line.product.name} ${line.product.sku} ${line.batch.batchNo}`
        .toLowerCase()
        .includes(q),
    );
  }, [query, stocktake]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  if (!stocktake) return null;

  const assigned =
    stocktake.assignments.map((entry) => entry.user.fullName).join(", ") ||
    stocktake.counter.fullName ||
    "—";
  const totalLines = filteredLines.length;
  const start = (page - 1) * PREVIEW_PAGE_SIZE;
  const previewLines = filteredLines.slice(start, start + PREVIEW_PAGE_SIZE);
  const pct = stocktake.progressPct ?? 0;
  const tone = pct >= 100 ? css.progressFillDone : pct > 0 ? css.progressFillWarn : "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={stocktake.title || stocktake.stocktakeNumber}
      description={`${stocktake.stocktakeNumber} · ${scopeLabel(stocktake.scope)}`}
      size="lg"
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose}>
            Close
          </ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => {
              onClose();
              router.push(stocktakeHref(stocktake.id));
            }}
          >
            Open workspace
          </ModalButton>
        </ModalFooter>
      }
    >
      <div className={scss.metaRow}>
        <StatusBadge status={stocktake.status} label={statusLabel(stocktake.status)} />
        {stocktake.blindCount ? <span className={scss.blindPill}>Blind count</span> : null}
        <span className={scss.scopeBadge}>{scopeLabel(stocktake.scope)}</span>
      </div>

      {stocktake.blindCount && stocktake.varianceLineCount == null ? (
        <p className={scss.blindBanner}>
          Expected quantities and variance are hidden until a supervisor reviews this blind count.
        </p>
      ) : null}

      <div className={css.detailGrid}>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Area</span>
          <span className={css.detailValue}>{stocktake.areaLabel || "Branch scope"}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Scheduled</span>
          <span className={css.detailValue}>{formatDateTime(stocktake.scheduledFor)}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Expected completion</span>
          <span className={css.detailValue}>{formatDateTime(stocktake.expectedCompletionAt)}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Movement handling</span>
          <span className={css.detailValue}>{movementModeLabel(stocktake.movementMode)}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Assigned to</span>
          <span className={css.detailValue}>{assigned}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Reviewer</span>
          <span className={css.detailValue}>{stocktake.reviewer?.fullName || "—"}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Created</span>
          <span className={css.detailValue}>{formatDate(stocktake.createdAt)}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Last updated</span>
          <span className={css.detailValue}>{formatDate(stocktake.updatedAt)}</span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Progress</span>
          <span className={css.detailValue}>
            {stocktake.countedLineCount}/{stocktake.lineCount} · {pct}%
          </span>
          <div className={css.progressTrack} aria-hidden style={{ marginTop: "0.35rem" }}>
            <div className={`${css.progressFill}${tone ? ` ${tone}` : ""}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Variance</span>
          <span className={css.detailValue}>
            {stocktake.varianceLineCount == null
              ? "Hidden"
              : stocktake.varianceLineCount === 0
                ? "None"
                : `${stocktake.varianceLineCount} line${stocktake.varianceLineCount === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Net units</span>
          <span className={css.detailValue}>
            {stocktake.varianceUnitsNet == null ? "Hidden" : formatSigned(stocktake.varianceUnitsNet)}
          </span>
        </div>
        <div className={css.detailField}>
          <span className={css.detailLabel}>Variance value</span>
          <span className={css.detailValue}>
            {stocktake.varianceValueApprox == null ? "Hidden" : formatMoney(stocktake.varianceValueApprox)}
          </span>
        </div>
      </div>

      {stocktake.notes ? (
        <div className={scss.notesBlock}>
          <strong>Notes:</strong> {stocktake.notes}
        </div>
      ) : null}

      <h3 className={css.sectionTitle}>Line preview</h3>
      {stocktake.lines.length === 0 ? (
        <p className={scss.emptyLines}>
          No lines yet
          {stocktake.scope === "custom"
            ? " — add batches from the workspace."
            : stocktake.lineCount === 0
              ? " — seed or add lines from the workspace."
              : "."}
        </p>
      ) : (
        <>
          <div className={scss.previewToolbar}>
            <div className={scss.pickerSearchWrap}>
              <IconSearch size={14} className={scss.pickerSearchIcon} />
              <input
                className={scss.pickerSearch}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search product, SKU, or batch…"
                aria-label="Search line preview"
              />
            </div>
            <span className={scss.previewCount}>
              {totalLines} of {stocktake.lines.length}
            </span>
          </div>
          {totalLines === 0 ? (
            <p className={scss.emptyLines}>No lines match “{query.trim()}”.</p>
          ) : (
            <div className={scss.linesTableWrap}>
              <div className={scss.linesTableScroll}>
                <table className={scss.linesTable}>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Batch</th>
                      <th>Expiry</th>
                      <th className={scss.num}>Counted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <div className={scss.productCell}>
                            <span className={scss.productName}>{line.product.name}</span>
                            <span className={scss.productMeta}>{line.product.sku}</span>
                          </div>
                        </td>
                        <td>{line.batch.batchNo}</td>
                        <td>{formatDate(line.batch.expiryDate)}</td>
                        <td className={scss.num}>{line.countedQty ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <StocktakeTablePager
                page={page}
                pageSize={PREVIEW_PAGE_SIZE}
                total={totalLines}
                onPageChange={setPage}
              />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
