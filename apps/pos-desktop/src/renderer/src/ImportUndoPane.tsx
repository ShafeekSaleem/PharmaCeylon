import { useEffect, useRef, useState } from "react";
import { formatDisplayDate, type CounterUndoableImport } from "@pharmaceylon/shared";
import styles from "./CounterDocumentPane.module.css";
import work from "./CounterWork.module.css";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { KeyScope, useKeyBinding } from "./keymap";
import { plural, qty, STOCKTAKE_PAGE } from "./stocktake-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

const STAGED = "Opening stock posted from a staged draft is not listed here: correct it with a stock adjustment.";

/** "Uploaded with its stock · 17 Nov by Kasun J." */
export function uploadedLine(imp: CounterUndoableImport) {
  const at = imp.uploaded.at ? ` · ${formatDisplayDate(imp.uploaded.at)}` : "";
  const by = imp.uploaded.name ? ` by ${imp.uploaded.name}` : "";
  return `Uploaded with its stock${at}${by}`;
}

/** What undo takes back, said the same way on the sheet and in the tests. */
export function undoSentence(imp: CounterUndoableImport) {
  const stock = `all the stock it posted (${plural(imp.batches, "batch", "batches")}, ${plural(imp.units, "unit")})`;
  const created =
    imp.productsCreated > 0
      ? `Undo takes back the whole import: the ${plural(imp.productsCreated, "product")} it created ${
          imp.productsCreated === 1 ? "is" : "are"
        } removed from the catalogue, along with ${stock}.`
      : `Undo takes back ${stock}.`;
  const updated =
    imp.productsUpdated > 0
      ? ` The ${plural(imp.productsUpdated, "product")} it only updated ${
          imp.productsUpdated === 1 ? "stays, but loses" : "stay, but lose"
        } the stock the import added to ${imp.productsUpdated === 1 ? "it" : "them"}.`
      : "";
  return created + updated;
}

function ConfirmSheet({
  imp,
  busy,
  onUndo,
  onCancel,
}: {
  imp: CounterUndoableImport;
  busy: boolean;
  onUndo: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  // Esc goes back. Undo is a click on purpose: it removes products from the catalogue.
  useKeyBinding("Escape", onCancel, { enabled: !busy });
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className={styles.sheet}
      role="dialog"
      aria-modal="true"
      aria-labelledby="imp-undo-title"
    >
      <div>
        <b id="imp-undo-title">Undo {imp.filename}?</b>
        <small className={styles.hint}>{uploadedLine(imp)}</small>
      </div>
      <p>{undoSentence(imp)}</p>
      <ul className={styles.checks}>
        <li>
          <Icon name="check" />
          No stock from this import has been sold or moved
        </li>
        <li>
          <Icon name="check" />
          None of its products has been sold, ordered or transferred
        </li>
      </ul>
      <p className={styles.hint}>{STAGED}</p>
      <div className={styles.actions}>
        <button type="button" className={cx(ui.btn, ui.outline)} disabled={busy} onClick={onCancel}>
          Cancel
          <KeyHint keys="Escape" small />
        </button>
        <button type="button" className={cx(ui.btn, ui.primary)} disabled={busy} onClick={onUndo}>
          <Icon name="rotate-ccw" />
          {busy ? "Undoing…" : "Undo the import"}
        </button>
      </div>
    </section>
  );
}

/**
 * `imp-undo` Undo an import uploaded with its stock (decision 5). It removes the products the
 * import created and every batch it posted, including stock added to products it only updated
 * (those products stay). The Imports filter lists an import only while undo is still allowed.
 */
export function ImportUndoDetail({
  imp,
  online,
  canUndo,
  onUndone,
  onRefused,
}: {
  imp: CounterUndoableImport;
  online: boolean;
  /** Nothing else at this counter is waiting to be confirmed. */
  canUndo: boolean;
  /** Said in the list once the import has gone from it. */
  onUndone: (message: string) => void;
  /** Read the list again: the import may have dropped off it. */
  onRefused: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(STOCKTAKE_PAGE);
  const ready = online && canUndo;
  const shown = imp.lines.slice(0, limit);
  const stocked = new Set(imp.lines.filter((l) => l.newProduct).map((l) => l.productId));
  const createdWithoutStock = imp.createdProducts.filter((p) => !stocked.has(p.productId));

  useEffect(() => {
    if (!ready) setConfirming(false);
  }, [ready]);

  const undo = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const result = await invoke(() => window.pos.undoCounterImport({ importId: imp.importId }));
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.error.message);
      onRefused();
      return;
    }
    const v = result.value;
    onUndone(
      `Undone ${v.filename}: ${plural(v.productsRemoved, "product")} removed from the catalogue and ${plural(
        v.batchesRemoved,
        "batch",
        "batches",
      )} of stock taken back${v.productsLeftInPlace ? `; ${plural(v.productsLeftInPlace, "product")} kept with the import's changes` : ""}.`,
    );
  };

  return (
    <section className={cx(ui.panel, work.detail)} aria-label={`Undo ${imp.filename}`}>
      <div className={work.dh}>
        <span className={cx(ui.kind, work.kind)}>
          <Icon name="rotate-ccw" />
        </span>
        <div className={work.dhMain}>
          <div className={ui.eyebrow}>Undo an import</div>
          <h2>{imp.filename}</h2>
          <div className={work.meta}>
            <span>
              <Icon name="upload" />
              {uploadedLine(imp)}
            </span>
            <span>
              <Icon name="package" />
              {plural(imp.lines.length, "row")} · {plural(imp.productsCreated, "new product")}
            </span>
          </div>
        </div>
        <div className={work.dhRight}>
          <span className={cx(ui.pill, ui.brand)}>
            <Icon name="check" />
            Can be undone
          </span>
        </div>
      </div>

      <div className={styles.content}>
        <div className={cx(ui.note, styles.waiting)} role="note">
          <Icon name="info" />
          <div>
            Nothing from this import has been sold, moved, ordered or transferred, so it can still be undone. The
            filter drops it once that changes.
            {imp.stopped && " The import was stopped part-way; undo removes what it did post."}
          </div>
        </div>

        <table className={styles.lines}>
          <thead>
            <tr>
              <th>Product</th>
              <th>Batch</th>
              <th>Expiry</th>
              <th className={styles.num}>Units</th>
              <th>Undo</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l, n) => (
              <tr key={`${l.batchId ?? l.productId}:${n}`}>
                <td>{l.productName}</td>
                <td>{l.batchNo ?? "—"}</td>
                <td>{l.expiryDate ? l.expiryDate.slice(0, 7) : "—"}</td>
                <td className={styles.num}>{qty(l.qty)}</td>
                <td>{l.newProduct ? "New product" : "Updated · product stays"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {imp.lines.length > shown.length && (
          <div className={styles.actions}>
            <small className={styles.hint}>{plural(imp.lines.length - shown.length, "more row")}</small>
            <button type="button" className={cx(ui.btn, ui.outline)} onClick={() => setLimit((n) => n + STOCKTAKE_PAGE)}>
              Show {qty(Math.min(STOCKTAKE_PAGE, imp.lines.length - shown.length))} more
            </button>
          </div>
        )}
        {createdWithoutStock.length > 0 && (
          <p className={styles.hint}>
            Undo also removes {plural(createdWithoutStock.length, "product")} the import created without stock:{" "}
            {createdWithoutStock
              .slice(0, 5)
              .map((p) => p.productName)
              .join(", ")}
            {createdWithoutStock.length > 5 ? ` and ${qty(createdWithoutStock.length - 5)} more` : ""}.
          </p>
        )}

        {error && (
          <p role="alert" className={ui.badText}>
            {error}
          </p>
        )}

        {confirming ? (
          <KeyScope layer>
            <ConfirmSheet imp={imp} busy={busy} onUndo={() => void undo()} onCancel={() => setConfirming(false)} />
          </KeyScope>
        ) : (
          <div className={styles.actions}>
            <small className={styles.hint}>
              {!online
                ? "Undo needs the server. This counter is offline."
                : !canUndo
                  ? "Confirm the action waiting at this counter first."
                  : STAGED}
            </small>
            <button
              type="button"
              className={cx(ui.btn, ui.primary)}
              disabled={!ready}
              onClick={() => setConfirming(true)}
            >
              <Icon name="rotate-ccw" />
              Undo the import
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
