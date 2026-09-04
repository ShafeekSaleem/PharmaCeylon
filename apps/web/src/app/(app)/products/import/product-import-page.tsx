"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconPackage,
  IconRotateCcw,
  IconUpload,
} from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/auth-client";
import { getBranchId } from "@/lib/auth-session";
import { usePageChrome } from "@/lib/page-chrome-context";
import css from "./import.module.css";
import {
  CONFIDENCE_LABELS,
  FIELD_HINTS,
  FIELD_LABELS,
  PRODUCT_FIELDS,
  STOCK_FIELDS,
  type ImportField,
  type ImportRowIssue,
  type ImportStep,
  type MatchConfidence,
} from "./types";
import { ImportCategoryBlock } from "./components/import-category-block";
import { useProductMeta } from "../hooks/use-product-meta";
import { useProductImport } from "./use-product-import";

const STEPS: Array<{ id: ImportStep; label: string }> = [
  { id: "upload", label: "Upload" },
  { id: "map", label: "Match columns" },
  { id: "review", label: "Review" },
  { id: "done", label: "Import" },
];

function stepIndex(step: ImportStep): number {
  if (step === "running") return 3;
  return STEPS.findIndex((s) => s.id === step);
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "preparing":
      return "Preparing…";
    case "matching":
      return "Matching against your catalog…";
    case "products":
      return "Creating and updating products…";
    case "stock":
      return "Posting opening stock…";
    case "done":
      return "Finishing…";
    default:
      return "Working…";
  }
}

async function downloadCsv(path: string, filename: string) {
  const res = await apiFetch(path);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "good" | "warn";
}) {
  return (
    <div
      className={`${css.stat}${tone === "good" ? ` ${css.statGood}` : ""}${
        tone === "warn" ? ` ${css.statWarn}` : ""
      }`}
    >
      <span className={css.statValue}>{value}</span>
      <span className={css.statLabel}>{label}</span>
    </div>
  );
}

const ISSUES_PER_PAGE = 10;

/**
 * Rejected rows, paged. A 2,000-row file can reject hundreds, and rendering them all turned
 * the review step into a page nobody could scroll past to reach the Import button.
 */
function IssueTable({ issues }: { issues: ImportRowIssue[] }) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(issues.length / ISSUES_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * ISSUES_PER_PAGE;
  const shown = issues.slice(start, start + ISSUES_PER_PAGE);

  return (
    <>
      <div className={css.scrollX}>
        <table className={css.issueTable}>
          <thead>
            <tr>
              <th>Row</th>
              <th>Product</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((issue) => (
              <tr key={`${issue.rowNumber}-${issue.message}`}>
                <td className={css.dim}>{issue.rowNumber}</td>
                <td>{issue.name || <span className={css.dim}>—</span>}</td>
                <td>{issue.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className={css.pager}>
          <span className={css.dim}>
            {start + 1}–{Math.min(start + ISSUES_PER_PAGE, issues.length)} of{" "}
            {issues.length.toLocaleString()}
          </span>
          <div className={css.pagerBtns}>
            <button
              type="button"
              className={css.pagerBtn}
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className={css.pagerBtn}
              disabled={safePage >= pageCount}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function ProductImportPage() {
  const io = useProductImport();
  // The commercial tree drives the Review step's category dropdowns.
  const { categories } = useProductMeta();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hasBranch = Boolean(getBranchId());
  const { setLastSegmentLabel } = usePageChrome();

  // Without this the breadcrumb reads the raw path segment, "import".
  useEffect(() => {
    setLastSegmentLabel("Import products");
    return () => setLastSegmentLabel(null);
  }, [setLastSegmentLabel]);

  const current = stepIndex(io.step);
  const stockMapped = STOCK_FIELDS.some((f) => Boolean(io.mapping[f]));
  const pendingUnconfirmed =
    (io.preview?.pendingCompliance ?? []).filter(
      (p) => !io.confirmedRows.has(p.rowNumber),
    ).length;

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) void io.chooseFile(dropped);
  };

  const columnOptions = io.analysis?.headers ?? [];

  function mappingRow(field: ImportField) {
    const selected = io.mapping[field] ?? "";
    const sample =
      selected && io.analysis?.sampleRows.find((r) => r[selected])?.[selected];
    return (
      <tr key={field}>
        <th scope="row" className={css.mapField}>
          {FIELD_LABELS[field]}
          {field === "name" && <span className={css.required}>required</span>}
          {FIELD_HINTS[field] && (
            <span className={css.mapHint}>{FIELD_HINTS[field]}</span>
          )}
        </th>
        <td>
          <select
            className={css.mapSelect}
            value={selected}
            onChange={(e) => io.setField(field, e.target.value)}
            aria-label={`Column for ${FIELD_LABELS[field]}`}
          >
            <option value="">— not in my file —</option>
            {columnOptions.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </td>
        <td className={css.mapSample}>{sample || <span className={css.dim}>—</span>}</td>
      </tr>
    );
  }

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Bring your product list across from another system — with opening stock on the same rows."
      />

      <div className={css.stepper} role="list" aria-label="Import progress">
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <div
              key={s.id}
              className={css.stepItem}
              role="listitem"
              aria-current={active ? "step" : undefined}
            >
              <div className={css.stepDotRow}>
                <span
                  className={`${css.stepConnector}${i <= current ? ` ${css.stepConnectorDone}` : ""}`}
                />
                <span
                  className={`${css.stepDot}${done ? ` ${css.stepDotDone}` : ""}${
                    active ? ` ${css.stepDotActive}` : ""
                  }`}
                >
                  {done ? <IconCheck size={13} /> : i + 1}
                </span>
                <span
                  className={`${css.stepConnector}${i < current ? ` ${css.stepConnectorDone}` : ""}`}
                />
              </div>
              <span
                className={`${css.stepLabel}${!done && !active ? ` ${css.stepLabelPending}` : ""}`}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      {io.error && (
        <Alert variant="error" onClose={io.dismissError}>
          {io.error}
        </Alert>
      )}

      {/* ── Step 1: upload ─────────────────────────────────────────────── */}
      {io.step === "upload" && (
        <section className={css.card}>
          <div
            className={`${css.dropzone}${dragging ? ` ${css.dropzoneActive}` : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
          >
            <IconUpload size={26} />
            <strong>{io.busy ? "Reading your file…" : "Drop your product list here"}</strong>
            <span className={css.dim}>
              CSV or Excel, up to 20 MB. Any column names — you&apos;ll match them next.
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xls,.xlsx"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void io.chooseFile(f);
                e.target.value = "";
              }}
            />
          </div>

          <div className={css.uploadAside}>
            <p className={css.dim}>
              Don&apos;t have an export? Start from our template — it has every column the
              importer understands, with two example rows.
            </p>
            <button
              type="button"
              className={css.secondaryBtn}
              onClick={() =>
                void downloadCsv(
                  "/products/import/template",
                  "product-import-template.csv",
                )
              }
            >
              <IconDownload size={15} />
              Download template
            </button>
          </div>
        </section>
      )}

      {/* ── Step 2: map columns ────────────────────────────────────────── */}
      {io.step === "map" && io.analysis && (
        <section className={css.card}>
          <header className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>Match your columns</h2>
              <p className={css.dim}>
                {io.file?.name} · {io.analysis.totalRows.toLocaleString()} row
                {io.analysis.totalRows === 1 ? "" : "s"} · we&apos;ve guessed these from your
                headers, change anything that looks wrong.
              </p>
            </div>
          </header>

          {io.analysis.unmappedHeaders.length > 0 && (
            <Alert variant="info">
              These columns aren&apos;t being used:{" "}
              <strong>{io.analysis.unmappedHeaders.join(", ")}</strong>. Match one above if it
              belongs somewhere, otherwise it will be ignored.
            </Alert>
          )}

          <h3 className={css.groupTitle}>Product details</h3>
          <table className={css.mapTable}>
            <thead>
              <tr>
                <th>Field</th>
                <th>Your column</th>
                <th>Example value</th>
              </tr>
            </thead>
            <tbody>{PRODUCT_FIELDS.map(mappingRow)}</tbody>
          </table>

          <h3 className={css.groupTitle}>
            Opening stock <span className={css.optional}>optional</span>
          </h3>
          <p className={css.dim}>
            Map a quantity column to bring your stock in from the same file. Leave these blank
            to import products only.
          </p>
          <table className={css.mapTable}>
            <thead>
              <tr>
                <th>Field</th>
                <th>Your column</th>
                <th>Example value</th>
              </tr>
            </thead>
            <tbody>{STOCK_FIELDS.map(mappingRow)}</tbody>
          </table>

          {stockMapped && !hasBranch && (
            <Alert variant="warning">
              Select a branch in the header before importing opening stock — stock is always
              held at a branch.
            </Alert>
          )}

          <footer className={css.cardFoot} data-fab-avoid>
            <button type="button" className={css.secondaryBtn} onClick={io.reset}>
              Choose a different file
            </button>
            <button
              type="button"
              className={css.primaryBtn}
              disabled={io.busy || !io.mapping.name || (stockMapped && !hasBranch)}
              onClick={() => void io.runPreview()}
            >
              {io.busy ? "Checking…" : "Preview import"}
            </button>
          </footer>
        </section>
      )}

      {/* ── Step 3: review ─────────────────────────────────────────────── */}
      {io.step === "review" && io.preview && (
        <section className={css.card}>
          <header className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>Review before importing</h2>
              <p className={css.dim}>Nothing has been changed yet.</p>
            </div>
          </header>

          <div className={css.statRow}>
            <Stat label="New products" value={io.preview.create} tone="good" />
            <Stat label="Matched to existing" value={io.preview.update} />
            <Stat label="Rows skipped" value={io.preview.skip} tone={io.preview.skip ? "warn" : undefined} />
            {io.preview.hasStockColumns && (
              <>
                <Stat label="Batches to create" value={io.preview.withStock} />
                <Stat label="Units of stock" value={io.preview.unitsToPost.toLocaleString()} />
              </>
            )}
          </div>

          {io.preview.update > 0 && (
            <>
              <h3 className={css.groupTitle}>How rows were matched</h3>
              <div className={css.chipRow}>
                {(Object.keys(io.preview.matchCounts) as MatchConfidence[])
                  .filter((k) => io.preview!.matchCounts[k] > 0)
                  .map((k) => (
                    <span key={k} className={css.chip}>
                      {CONFIDENCE_LABELS[k]}
                      <strong>{io.preview!.matchCounts[k]}</strong>
                    </span>
                  ))}
              </div>
              {io.preview.sampleMatches.length > 0 && (
                <ul className={css.sampleList}>
                  {io.preview.sampleMatches.map((m) => (
                    <li key={m.rowNumber}>
                      <span className={css.dim}>Row {m.rowNumber}</span> {m.name}{" "}
                      <span className={css.arrow}>→</span> {m.matchedName}{" "}
                      <span className={css.miniChip}>{CONFIDENCE_LABELS[m.confidence]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {io.preview.create > 0 && (
            <ImportCategoryBlock
              plan={io.preview.categoryPlan}
              categories={categories}
              choices={io.categoryChoices}
              onChange={io.setCategoryChoice}
            />
          )}

          {io.preview.missingExpiry > 0 && (
            <Alert variant="info">
              <strong>{io.preview.missingExpiry}</strong> batch
              {io.preview.missingExpiry === 1 ? " has" : "es have"} no expiry date. They&apos;ll
              be imported and flagged for review rather than rejected — find them later under
              Inventory → Batches.
            </Alert>
          )}

          {io.preview.pendingCompliance.length > 0 && (
            <div className={css.complianceBox}>
              <header className={css.complianceHead}>
                <span className={css.complianceIcon}>
                  <IconAlertTriangle size={17} />
                </span>
                <div>
                  <strong>
                    {io.preview.pendingCompliance.length} row
                    {io.preview.pendingCompliance.length === 1 ? "" : "s"} need your confirmation
                  </strong>
                  <p className={css.dim}>
                    These matched on generic name and strength rather than a barcode or
                    registration number, and the match would mark the product controlled or
                    prescription-only. Getting that wrong blocks a legitimate sale — or fails to
                    block one. Tick the ones that are right; anything left unticked is skipped
                    and listed in the error report.
                  </p>
                </div>
                <button
                  type="button"
                  className={css.secondaryBtn}
                  onClick={io.confirmAllPending}
                >
                  Confirm all
                </button>
              </header>
              <ul className={css.complianceList}>
                {io.preview.pendingCompliance.map((p) => (
                  <li key={p.rowNumber}>
                    <label className={css.complianceItem}>
                      <input
                        type="checkbox"
                        checked={io.confirmedRows.has(p.rowNumber)}
                        onChange={() => io.toggleConfirmedRow(p.rowNumber)}
                      />
                      <span>
                        <span className={css.dim}>Row {p.rowNumber}</span> {p.name}{" "}
                        <span className={css.arrow}>→</span> {p.matchedName}
                        {p.matchedRegistrationNo && (
                          <span className={css.dim}> · Reg. {p.matchedRegistrationNo}</span>
                        )}
                        <span className={css.flagRow}>
                          {p.wouldSetControlled && (
                            <span className={css.flagChip}>Controlled</span>
                          )}
                          {p.wouldSetPrescription && (
                            <span className={css.flagChip}>Prescription only</span>
                          )}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {io.preview.issues.length > 0 && (
            <>
              <h3 className={css.groupTitle}>
                Rows that won&apos;t be imported
                <span className={css.optional}>{io.preview.issues.length}</span>
              </h3>
              <IssueTable issues={io.preview.issues} />
            </>
          )}

          <footer className={css.cardFoot} data-fab-avoid>
            <button
              type="button"
              className={css.secondaryBtn}
              onClick={() => io.setStep("map")}
            >
              Back to columns
            </button>
            <button
              type="button"
              className={css.primaryBtn}
              disabled={io.busy || io.preview.create + io.preview.update === 0}
              onClick={() => void io.runImport()}
            >
              Import {(io.preview.create + io.preview.update).toLocaleString()} product
              {io.preview.create + io.preview.update === 1 ? "" : "s"}
              {pendingUnconfirmed > 0 ? ` (skipping ${pendingUnconfirmed} unconfirmed)` : ""}
            </button>
          </footer>
        </section>
      )}

      {/* ── Step 4: running ────────────────────────────────────────────── */}
      {io.step === "running" && (
        <section className={css.card}>
          <h2 className={css.cardTitle}>{phaseLabel(io.progress?.phase ?? "preparing")}</h2>
          <div className={css.progressTrack}>
            <div
              className={css.progressBar}
              style={{
                width: `${
                  io.progress && io.progress.total > 0
                    ? Math.min(100, Math.round((io.progress.processed / io.progress.total) * 100))
                    : 5
                }%`,
              }}
            />
          </div>
          <p className={css.dim}>
            {io.progress
              ? `${io.progress.processed.toLocaleString()} of ${io.progress.total.toLocaleString()} · ${io.progress.productsCreated} created, ${io.progress.productsUpdated} updated, ${io.progress.batchesCreated} batches`
              : "Starting…"}
          </p>
          <p className={css.dim}>You can leave this page — the import keeps running.</p>
        </section>
      )}

      {/* ── Step 5: done ───────────────────────────────────────────────── */}
      {io.step === "done" && io.result && (
        <section className={css.card}>
          <header className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>Import complete</h2>
              <p className={css.dim}>{io.file?.name}</p>
            </div>
          </header>

          <div className={css.statRow}>
            <Stat label="Products created" value={io.result.productsCreated} tone="good" />
            <Stat label="Products updated" value={io.result.productsUpdated} />
            {io.result.productsRanged > 0 && (
              <Stat label="Added from the register" value={io.result.productsRanged} />
            )}
            <Stat label="Batches created" value={io.result.batchesCreated} />
            <Stat label="Units posted" value={io.result.unitsPosted.toLocaleString()} />
            {io.result.rowsFailed > 0 && (
              <Stat label="Rows skipped" value={io.result.rowsFailed} tone="warn" />
            )}
          </div>

          {io.result.productsCreated > 0 && (
            <p className={css.dim}>
              Filed under a category:{" "}
              <strong>{io.result.categorizedFromFile.toLocaleString()}</strong> from your file,{" "}
              <strong>{io.result.categorizedByClassifier.toLocaleString()}</strong> sorted
              automatically
              {io.result.leftUnclassified > 0 ? (
                <>
                  , <strong>{io.result.leftUnclassified.toLocaleString()}</strong> left in
                  Unclassified for you to place
                </>
              ) : null}
              .
            </p>
          )}

          {io.result.expiryReviewCount > 0 && (
            <Alert variant="info">
              <strong>{io.result.expiryReviewCount}</strong> batch
              {io.result.expiryReviewCount === 1 ? "" : "es"} came in without an expiry date.
              They&apos;re held out of expiry alerts until you confirm the real dates —{" "}
              <Link href="/inventory/batches?needsExpiryReview=true" className={css.inlineLink}>
                review them now
              </Link>
              .
            </Alert>
          )}

          <footer className={css.cardFoot} data-fab-avoid>
            <div className={css.footLeft}>
              {io.result.rowsFailed > 0 && (
                <button
                  type="button"
                  className={css.secondaryBtn}
                  onClick={() =>
                    void downloadCsv(
                      `/products/import/${io.result!.importId}/errors`,
                      "import-errors.csv",
                    )
                  }
                >
                  <IconDownload size={15} />
                  Download skipped rows
                </button>
              )}
            </div>
            <button type="button" className={css.secondaryBtn} onClick={io.reset}>
              Import another file
            </button>
            <Link href="/products" className={css.primaryBtn}>
              <IconPackage size={15} />
              View my products
            </Link>
          </footer>
        </section>
      )}

      {/* ── Recent imports / undo ──────────────────────────────────────── */}
      {io.history.length > 0 && (
        <section className={css.card}>
          <h2 className={css.cardTitle}>Recent imports</h2>
          <p className={css.dim}>
            An import can be undone while nothing has been sold from it. Undo removes the
            products it created and the stock it posted; products it only matched and updated
            stay as they are.
          </p>
          <table className={css.historyTable}>
            <thead>
              <tr>
                <th>File</th>
                <th>When</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {io.history.map((h) => (
                <tr key={h.id}>
                  <td>
                    <strong>{h.filename}</strong>
                    {h.actorName && <span className={css.dim}> · {h.actorName}</span>}
                  </td>
                  <td className={css.dim}>
                    {new Date(h.createdAt).toLocaleString()}
                  </td>
                  <td>
                    {h.status === "undone" ? (
                      <span className={css.dim}>Undone</span>
                    ) : h.status === "failed" ? (
                      <span className={css.failedTag}>Failed</span>
                    ) : (
                      <>
                        {h.productsCreated} created · {h.productsUpdated} updated
                        {h.batchesCreated > 0 && ` · ${h.batchesCreated} batches`}
                      </>
                    )}
                  </td>
                  <td className={css.historyAction}>
                    {h.canUndo ? (
                      <button
                        type="button"
                        className={css.undoBtn}
                        disabled={io.busy}
                        onClick={() => void io.undo(h.id)}
                      >
                        <IconRotateCcw size={14} />
                        Undo
                      </button>
                    ) : (
                      h.undoBlockedReason && (
                        <span className={css.dim} data-tooltip={h.undoBlockedReason}>
                          Can&apos;t undo
                        </span>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
