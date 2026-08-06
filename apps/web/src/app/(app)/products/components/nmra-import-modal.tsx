"use client";

import { useRef, useState, type DragEvent } from "react";
import { Alert } from "@/components/alert";
import { IconUpload, IconX } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiFetch } from "@/lib/auth-client";
import css from "../products.module.css";

type PreviewResult = {
  totalRows: number;
  create: number;
  update: number;
  skip: number;
  errors: Array<{ registrationNo?: string; message: string }>;
  sampleCreates: Array<{ registrationNo: string; name: string; brandName: string | null }>;
  sampleUpdates: Array<{
    registrationNo: string;
    name: string;
    existingName: string;
  }>;
};

type ConfirmResult = {
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ registrationNo?: string; message: string }>;
  categoryMapsAdded: number;
  tagsTouched: number;
};

type JobProgress = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  phase: string;
  processed: number;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errorCount: number;
  result?: ConfirmResult;
  error?: string;
};

type BarcodeResult = {
  updated: number;
  skipped: number;
  errors: Array<{ line: number; message: string }>;
};

type Tab = "nmra" | "barcodes";
type BusyAction = "preview" | "confirm" | "barcode" | null;

type Props = {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
};

const POLL_MS = 750;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "preparing":
      return "Preparing…";
    case "creating":
      return "Creating products…";
    case "updating":
      return "Updating products…";
    case "taxonomy":
      return "Linking categories…";
    case "tags":
      return "Linking tags…";
    case "aliases":
      return "Linking aliases…";
    case "done":
      return "Finishing…";
    default:
      return "Processing…";
  }
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={css.nmraStatTile}>
      <span className={css.nmraStatValue}>{value}</span>
      <span className={css.nmraStatLabel}>{label}</span>
    </div>
  );
}

async function readErrorMessage(res: Response, text: string): Promise<string> {
  let message = `Request failed (${res.status})`;
  try {
    const body = JSON.parse(text) as { message?: string | string[] };
    if (Array.isArray(body.message)) message = body.message.join(", ");
    else if (body.message) message = body.message;
  } catch {
    if (text.trim()) message = text;
  }
  return message;
}

export function NmraImportModal({ open, onClose, onImported }: Props) {
  const [tab, setTab] = useState<Tab>("nmra");
  const [file, setFile] = useState<File | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [barcodeResult, setBarcodeResult] = useState<BarcodeResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = busyAction !== null;
  const successState = Boolean(result || barcodeResult);
  const confirmRunning = busyAction === "confirm";

  const reset = () => {
    setFile(null);
    setError(null);
    setPreview(null);
    setResult(null);
    setProgress(null);
    setBarcodeResult(null);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const switchTab = (next: Tab) => {
    if (busy || successState) return;
    setTab(next);
    reset();
  };

  const acceptFile = (next: File | null) => {
    setFile(next);
    setPreview(null);
    setResult(null);
    setProgress(null);
    setBarcodeResult(null);
    setError(null);
    if (!next && inputRef.current) inputRef.current.value = "";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (busy || successState) return;
    const dropped = e.dataTransfer.files?.[0] ?? null;
    if (dropped) acceptFile(dropped);
  };

  const upload = async (path: string, action: BusyAction) => {
    if (!file) {
      setError("Choose a file first.");
      return null;
    }
    setBusyAction(action);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch(path, { method: "POST", body: form });
      const text = await res.text();
      if (!res.ok) throw new Error(await readErrorMessage(res, text));
      return text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const pollJob = async (jobId: string): Promise<JobProgress> => {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = await apiFetch(`/products/nmra-import/jobs/${jobId}`);
      const text = await res.text();
      if (!res.ok) throw new Error(await readErrorMessage(res, text));
      const data = JSON.parse(text) as JobProgress;
      setProgress(data);
      if (data.status === "completed" || data.status === "failed") return data;
    }
  };

  const runPreview = async () => {
    setResult(null);
    setProgress(null);
    const data = (await upload("/products/nmra-import/preview", "preview")) as PreviewResult | null;
    if (data) setPreview(data);
  };

  const runConfirm = async () => {
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setBusyAction("confirm");
    setError(null);
    setResult(null);
    setProgress({
      jobId: "",
      status: "queued",
      phase: "preparing",
      processed: 0,
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errorCount: 0,
    });
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/products/nmra-import/confirm", {
        method: "POST",
        body: form,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(await readErrorMessage(res, text));
      const started = JSON.parse(text) as { jobId?: string };
      if (!started.jobId) throw new Error("Import job did not return a job id.");

      const final = await pollJob(started.jobId);
      if (final.status === "failed") {
        throw new Error(final.error || "NMRA import failed");
      }
      const confirmResult = final.result ?? {
        parsed: final.created + final.updated + final.skipped,
        created: final.created,
        updated: final.updated,
        skipped: final.skipped,
        errors: [],
        categoryMapsAdded: 0,
        tagsTouched: 0,
      };
      setResult(confirmResult);
      setPreview(null);
      setProgress(null);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upsert failed");
      setProgress(null);
    } finally {
      setBusyAction(null);
    }
  };

  const runBarcodeImport = async () => {
    const data = (await upload("/products/barcodes/import", "barcode")) as BarcodeResult | null;
    if (data) {
      setBarcodeResult(data);
      onImported();
    }
  };

  const accept =
    tab === "nmra" ? ".xls,.xlsx,.csv,application/vnd.ms-excel" : ".csv,text/csv";
  const dropLabel = tab === "nmra" ? "NMRA Excel / CSV" : "Barcode CSV";

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import from NMRA"
      size="md"
      footer={
        <ModalFooter className={css.nmraImportFooter}>
          <ModalButton variant="secondary" onClick={handleClose} disabled={busy}>
            {successState ? "Close" : "Cancel"}
          </ModalButton>
          {tab === "nmra" && !result && !confirmRunning && (
            <>
              <ModalButton
                variant="secondary"
                onClick={() => void runPreview()}
                disabled={busy || !file}
              >
                {busyAction === "preview" ? "Previewing…" : "Dry-run preview"}
              </ModalButton>
              <ModalButton
                onClick={() => void runConfirm()}
                disabled={busy || !file || !preview}
              >
                Confirm upsert
              </ModalButton>
            </>
          )}
          {tab === "barcodes" && !barcodeResult && (
            <ModalButton onClick={() => void runBarcodeImport()} disabled={busy || !file}>
              {busyAction === "barcode" ? "Importing…" : "Import barcodes"}
            </ModalButton>
          )}
        </ModalFooter>
      }
    >
      <div className={css.metaManagerTabs} role="tablist">
        <button
          type="button"
          role="tab"
          className={`${css.metaManagerTab} ${tab === "nmra" ? css.metaManagerTabActive : ""}`}
          onClick={() => switchTab("nmra")}
          disabled={busy || successState}
        >
          NMRA registration
        </button>
        <button
          type="button"
          role="tab"
          className={`${css.metaManagerTab} ${tab === "barcodes" ? css.metaManagerTabActive : ""}`}
          onClick={() => switchTab("barcodes")}
          disabled={busy || successState}
        >
          Barcode CSV
        </button>
      </div>

      <div className={css.nmraImportHintStack}>
        <p
          className={css.metaManagerHint}
          data-active={tab === "nmra" ? "true" : "false"}
          aria-hidden={tab !== "nmra"}
        >
          Upload NMRA Valid Registration (Excel). Matched by reg. no. Manual tags,
          aliases, SKU, and categories are kept; NMRA fields and tags are merged in.
        </p>
        <p
          className={css.metaManagerHint}
          data-active={tab === "barcodes" ? "true" : "false"}
          aria-hidden={tab !== "barcodes"}
        >
          CSV columns: <code>registrationNo</code> (or <code>productId</code> /{" "}
          <code>sku</code>) and <code>barcode</code>. Existing barcodes are updated;
          barcode aliases are added.
        </p>
      </div>

      {error && (
        <Alert variant="error" className={css.modalAlert}>
          {error}
        </Alert>
      )}

      {!result && !confirmRunning && (
        <div className={css.nmraFileField}>
          <span id="nmra-file-label">{dropLabel}</span>
          <input
            ref={inputRef}
            id="nmra-file-input"
            type="file"
            className={css.nmraFileInput}
            accept={accept}
            disabled={busy}
            aria-labelledby="nmra-file-label"
            onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
          />
          <div
            className={`${css.nmraDropzone}${dragOver ? ` ${css.nmraDropzoneActive}` : ""}${
              file ? ` ${css.nmraDropzoneHasFile}` : ""
            }`}
            role={file ? "button" : undefined}
            tabIndex={file && !busy ? 0 : undefined}
            onClick={() => {
              if (!busy && file) inputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if (!busy && file && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragOver(false);
            }}
            onDrop={onDrop}
          >
            {file ? (
              <div className={css.nmraFileSelected}>
                <div className={css.nmraFileMeta}>
                  <IconUpload size={18} />
                  <div>
                    <p className={css.nmraFileNameText}>{file.name}</p>
                    <p className={css.nmraFileSize}>
                      {formatFileSize(file.size)} · click to choose another file
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className={css.nmraFileClearBtn}
                  disabled={busy}
                  aria-label="Clear selected file"
                  onClick={(e) => {
                    e.stopPropagation();
                    acceptFile(null);
                  }}
                >
                  <IconX size={14} />
                </button>
              </div>
            ) : (
              <div className={css.nmraDropzoneEmpty}>
                <IconUpload size={22} />
                <p>
                  Drag and drop your file here, or{" "}
                  <button
                    type="button"
                    className={css.nmraBrowseBtn}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      inputRef.current?.click();
                    }}
                  >
                    browse
                  </button>
                </p>
                <p className={css.nmraDropzoneHint}>
                  {tab === "nmra" ? ".xls, .xlsx, or .csv" : ".csv"}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {confirmRunning && progress && (
        <div className={css.nmraProgress} aria-live="polite">
          <div className={css.nmraProgressHeader}>
            <span className={css.nmraProgressPhase}>{phaseLabel(progress.phase)}</span>
            <span className={css.nmraProgressPct}>
              {progress.total > 0 ? `${progressPct}%` : "…"}
            </span>
          </div>
          <div
            className={css.nmraProgressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.total > 0 ? progressPct : undefined}
            aria-valuetext={
              progress.total > 0
                ? `Processing ${progress.processed} of ${progress.total}`
                : phaseLabel(progress.phase)
            }
          >
            <div
              className={`${css.nmraProgressFill}${
                progress.total <= 0 ? ` ${css.nmraProgressFillIndeterminate}` : ""
              }`}
              style={progress.total > 0 ? { width: `${progressPct}%` } : undefined}
            />
          </div>
          <p className={css.nmraProgressMeta}>
            {progress.total > 0
              ? `Processing ${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()}…`
              : "Starting import job…"}
            {(progress.created > 0 || progress.updated > 0) && (
              <>
                {" "}
                · Created {progress.created.toLocaleString()} · Updated{" "}
                {progress.updated.toLocaleString()}
              </>
            )}
          </p>
        </div>
      )}

      {preview && !confirmRunning && !result && (
        <div className={css.nmraPreview}>
          <h4 className={css.nmraPreviewTitle}>Dry-run preview</h4>
          <div className={css.nmraStatGrid}>
            <StatTile label="Rows parsed" value={preview.totalRows} />
            <StatTile label="Would create" value={preview.create} />
            <StatTile label="Would update" value={preview.update} />
            <StatTile label="Would skip" value={preview.skip} />
          </div>
          {preview.sampleCreates.length > 0 && (
            <div className={css.nmraSample}>
              <strong>Sample creates</strong>
              <ul>
                {preview.sampleCreates.map((s) => (
                  <li key={s.registrationNo}>
                    {s.registrationNo} — {s.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.errors.length > 0 && (
            <Alert variant="error" className={css.modalAlert}>
              {preview.errors[0]!.message}
            </Alert>
          )}
        </div>
      )}

      {result && (
        <div className={css.nmraComplete}>
          <Alert variant="success" className={css.modalAlert}>
            Import completed successfully
          </Alert>
          <p className={css.nmraCompleteStats}>
            Parsed {result.parsed.toLocaleString()} · Created{" "}
            {result.created.toLocaleString()} · Updated {result.updated.toLocaleString()} ·
            Skipped {result.skipped.toLocaleString()}
            {result.errors.length > 0
              ? ` · Errors ${result.errors.length.toLocaleString()}`
              : ""}
            {result.categoryMapsAdded > 0 || result.tagsTouched > 0
              ? ` · Category maps +${result.categoryMapsAdded.toLocaleString()} · Tags +${result.tagsTouched.toLocaleString()}`
              : ""}
          </p>
          {result.errors[0] && (
            <Alert variant="warning" className={css.modalAlert}>
              {result.errors[0].registrationNo
                ? `${result.errors[0].registrationNo}: ${result.errors[0].message}`
                : result.errors[0].message}
            </Alert>
          )}
        </div>
      )}

      {barcodeResult && (
        <div className={css.nmraPreview}>
          <h4 className={css.nmraPreviewTitle}>Barcode import complete</h4>
          <div className={css.nmraStatGrid}>
            <StatTile label="Updated" value={barcodeResult.updated} />
            <StatTile label="Skipped" value={barcodeResult.skipped} />
            <StatTile label="Errors" value={barcodeResult.errors.length} />
          </div>
        </div>
      )}
    </Modal>
  );
}
