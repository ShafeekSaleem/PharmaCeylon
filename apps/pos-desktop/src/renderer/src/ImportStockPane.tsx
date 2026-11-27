import { useEffect, useRef, useState } from "react";
import type { CounterWorkImportCategory, CounterWorkImportDetail } from "@pharmaceylon/shared";
import styles from "./CounterDocumentPane.module.css";
import { Icon } from "./Icon";
import {
  buildImportPost,
  categoryKey,
  categoryLabel,
  joinNames,
  pickCategory,
  restOf,
  type ImportSelection,
} from "./import-stock-model";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { KeyScope, useKeyBinding } from "./keymap";
import { minor, money } from "./sell-model";
import { plural, qty, STOCKTAKE_PAGE } from "./stocktake-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

const FINAL = "Posted opening stock can't be undone. Correct it with a stock adjustment.";

function ConfirmSheet({
  detail,
  choice,
  busy,
  onPost,
  onCancel,
}: {
  detail: CounterWorkImportDetail;
  choice: ImportSelection;
  busy: boolean;
  onPost: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useKeyBinding("Ctrl+Enter", onPost, { enabled: !busy });
  useKeyBinding("Escape", onCancel, { enabled: !busy });
  const rest = restOf(detail);
  const one =
    choice.selection === "category"
      ? detail.categories.find((c) => c.categoryName === choice.categoryName) ?? null
      : null;
  const posting = one ? [one] : rest.categories;
  const rows = posting.reduce((n, c) => n + c.rows, 0);
  const units = posting.reduce((n, c) => n + c.units, 0);
  const action = one ? `Post ${categoryLabel(one.categoryName)} · ${plural(rows, "row")}` : `Post the rest · ${plural(rows, "row")}`;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className={styles.sheet}
      role="dialog"
      aria-modal="true"
      aria-labelledby="imp-confirm-title"
    >
      <div>
        <b id="imp-confirm-title">
          {one ? `Post ${categoryLabel(one.categoryName)} from ${detail.reference}?` : `Post the rest of ${detail.reference}?`}
        </b>
        <small className={styles.hint}>Staged version {detail.stockVersion} · no approval step</small>
      </div>
      <p>
        Posts <b>{plural(rows, "row")}</b> and <b>{plural(units, "unit")}</b> in {joinNames(posting)}.
        {rest.posted.length > 0 && ` ${joinNames(rest.posted)} ${rest.posted.length === 1 ? "was" : "were"} posted and ${rest.posted.length === 1 ? "is" : "are"} not posted again.`}
      </p>
      <ul className={styles.checks}>
        <li>
          <Icon name="check" />
          Each category posts once
        </li>
        <li>
          <Icon name="check" />
          Units go on sale at this branch straight away
        </li>
      </ul>
      <p className={styles.hint}>{FINAL}</p>
      <div className={styles.actions}>
        <button type="button" className={cx(ui.btn, ui.outline)} disabled={busy} onClick={onCancel}>
          Cancel
          <KeyHint keys="Escape" small />
        </button>
        <button type="button" className={cx(ui.btn, ui.primary)} disabled={busy} onClick={onPost}>
          {busy ? "Posting…" : action}
          <KeyHint keys="Ctrl+Enter" onPrimary small />
        </button>
      </div>
    </section>
  );
}

function CategoryTable({
  categories,
  chosen,
  onChoose,
}: {
  categories: ReadonlyArray<CounterWorkImportCategory>;
  chosen: CounterWorkImportCategory | null;
  onChoose: (c: CounterWorkImportCategory) => void;
}) {
  return (
    <table className={styles.lines}>
      <thead>
        <tr>
          <th aria-label="Show rows" />
          <th>Category</th>
          <th className={styles.num}>Rows</th>
          <th className={styles.num}>Batches</th>
          <th className={styles.num}>Units</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {categories.map((c) => (
          <tr key={categoryKey(c.categoryName)}>
            <td>
              <input
                type="radio"
                name="imp-category"
                aria-label={`Show ${categoryLabel(c.categoryName)}`}
                checked={chosen !== null && categoryKey(chosen.categoryName) === categoryKey(c.categoryName)}
                onChange={() => onChoose(c)}
              />
            </td>
            <td>{categoryLabel(c.categoryName)}</td>
            <td className={styles.num}>{qty(c.rows)}</td>
            <td className={styles.num}>{qty(c.batches)}</td>
            <td className={styles.num}>{qty(c.units)}</td>
            <td>{c.posted ? "Posted" : "To post"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * `imp` Post opening stock. A staged import, posted a category at a time or the rest at once.
 * There is no approval step: the post is pinned to the staged version shown, and the counter
 * never edits a row. Posting one category leaves the import here until every row is posted.
 */
export function ImportStockBody({
  detail,
  online,
  canPost,
  onPosted,
  onRefused,
}: {
  detail: CounterWorkImportDetail;
  online: boolean;
  /** Nothing else at this counter is waiting to be confirmed. */
  canPost: boolean;
  /** `remaining`: another category is still to post, so read the import again. */
  onPosted: (remaining: boolean) => void;
  onRefused: () => void;
}) {
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(STOCKTAKE_PAGE);
  const [confirming, setConfirming] = useState<ImportSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const rest = restOf(detail);
  const chosen = pickCategory(detail, chosenKey);
  const ready = online && canPost && !done && rest.categories.length > 0;
  const rows = chosen ? detail.rows.filter((r) => r.categoryName === chosen.categoryName) : [];
  const shown = rows.slice(0, limit);
  const showCost = rows.some((r) => r.unitCost !== null);
  const fewerBatches = detail.categories.filter((c) => c.batches !== c.rows);

  useEffect(() => {
    if (!ready) setConfirming(null);
  }, [ready]);

  useKeyBinding("Ctrl+Enter", () => setConfirming({ selection: "all" }), { enabled: ready && confirming === null });

  const choose = (c: CounterWorkImportCategory) => {
    setChosenKey(categoryKey(c.categoryName));
    setLimit(STOCKTAKE_PAGE);
  };

  const post = async (choice: ImportSelection) => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await invoke(() => window.pos.postCounterImportStock(buildImportPost(detail, choice)));
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setError(result.error.message);
      onRefused();
      return;
    }
    const v = result.value;
    const what =
      choice.selection === "category" ? categoryLabel(choice.categoryName) : `the rest of ${v.reference}`;
    const written = v.alreadyApplied
      ? `${what} was already posted.`
      : `Posted ${what}: ${plural(v.batchesPosted, "batch", "batches")}, ${plural(v.unitsPosted, "unit")} on sale now.`;
    if (v.remaining) {
      // Move on to the next category still to post once the import is read again.
      setChosenKey(null);
      setNotice(`${written} The other categories stay here to post.`);
      onPosted(true);
      return;
    }
    setDone(`${written} Everything in ${v.reference} is posted.`);
    onPosted(false);
  };

  return (
    <>
      <div className={styles.facts}>
        <span>
          <Icon name="upload" />
          {plural(detail.rows.length, "row")} · {plural(detail.categories.length, "category", "categories")}
        </span>
        <span>Version {detail.stockVersion}</span>
      </div>
      <p className={styles.hint}>
        Imports have no approval step: posting is pinned to version {detail.stockVersion}. Each category posts once,
        and its units go on sale straight away.
      </p>
      <CategoryTable categories={detail.categories} chosen={chosen} onChoose={choose} />
      {fewerBatches.length > 0 && (
        <p className={styles.hint}>
          Batches can be fewer than rows: rows naming the same product and batch post into one batch.{" "}
          {categoryLabel(fewerBatches[0]!.categoryName)} has {plural(fewerBatches[0]!.rows, "row")} and{" "}
          {plural(fewerBatches[0]!.batches, "batch", "batches")}.
        </p>
      )}

      {chosen && (
        <>
          <b>{categoryLabel(chosen.categoryName)} · {rows.length > shown.length ? "first rows" : "rows"}</b>
          <table className={styles.lines}>
            <thead>
              <tr>
                <th>Product</th>
                <th>Batch</th>
                <th>Expiry</th>
                <th className={styles.num}>Units</th>
                {showCost && <th className={styles.num}>Cost</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.rowNumber}>
                  <td>{r.productName}</td>
                  <td>{r.batchNo}</td>
                  <td>{r.expiryDate ? r.expiryDate.slice(0, 7) : "Needs expiry"}</td>
                  <td className={styles.num}>{qty(r.qty)}</td>
                  {showCost && <td className={styles.num}>{r.unitCost === null ? "—" : `Rs ${money(minor(r.unitCost))}`}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown.length && (
            <div className={styles.actions}>
              <small className={styles.hint}>
                Showing {qty(shown.length)} of {plural(rows.length, "row")}.
              </small>
              <button type="button" className={cx(ui.btn, ui.outline)} onClick={() => setLimit((n) => n + STOCKTAKE_PAGE)}>
                Show {qty(Math.min(STOCKTAKE_PAGE, rows.length - shown.length))} more
              </button>
            </div>
          )}
        </>
      )}

      {notice && !done && (
        <p className={ui.okText} role="status">
          {notice}
        </p>
      )}
      {done && (
        <p className={ui.okText} role="status">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className={ui.badText}>
          {error}
        </p>
      )}

      {confirming && !done && (
        <KeyScope layer>
          <ConfirmSheet
            detail={detail}
            choice={confirming}
            busy={busy}
            onPost={() => void post(confirming)}
            onCancel={() => setConfirming(null)}
          />
        </KeyScope>
      )}

      {!done && !confirming && (
        <div className={styles.actions}>
          <small className={styles.hint}>
            {!online
              ? "Posting needs the server. This counter is offline."
              : !canPost
                ? "Confirm the action waiting at this counter first."
                : rest.categories.length === 0
                  ? "Every category is posted."
                  : FINAL}
          </small>
          {chosen && !chosen.posted && (
            <button
              type="button"
              className={cx(ui.btn, ui.outline)}
              disabled={!ready}
              onClick={() => setConfirming({ selection: "category", categoryName: chosen.categoryName })}
            >
              Post {categoryLabel(chosen.categoryName)} · {plural(chosen.rows, "row")}
            </button>
          )}
          <button
            type="button"
            className={cx(ui.btn, ui.primary)}
            disabled={!ready}
            onClick={() => setConfirming({ selection: "all" })}
          >
            <Icon name="package-check" />
            Post the rest · {plural(rest.rows, "row")}
            <KeyHint keys="Ctrl+Enter" onPrimary small />
          </button>
        </div>
      )}
    </>
  );
}
