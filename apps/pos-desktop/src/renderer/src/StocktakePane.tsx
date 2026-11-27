import { useEffect, useRef, useState } from "react";
import type { CounterWorkStocktakeDetail, CounterWorkStocktakeLine } from "@pharmaceylon/shared";
import styles from "./CounterDocumentPane.module.css";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { KeyScope, useKeyBinding } from "./keymap";
import { isDifference, plural, qty, signed, signedRs, STOCKTAKE_PAGE, stocktakeSummary } from "./stocktake-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

type View = "differences" | "all";

function StocktakeLines({
  lines,
  showCost,
}: {
  lines: ReadonlyArray<CounterWorkStocktakeLine>;
  showCost: boolean;
}) {
  return (
    <table className={styles.lines}>
      <thead>
        <tr>
          <th>Product</th>
          <th>Batch</th>
          <th className={styles.num}>On hand at count</th>
          <th className={styles.num}>Counted</th>
          <th className={styles.num}>Difference</th>
          <th className={styles.num}>Now</th>
          <th className={styles.num}>After post</th>
          {showCost && <th className={styles.num}>At cost</th>}
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.lineId}>
            <td>
              {l.productName}
              {(l.packLabel || l.reviewNote) && (
                <small>{[l.packLabel, l.reviewNote && `“${l.reviewNote}”`].filter(Boolean).join(" · ")}</small>
              )}
            </td>
            <td>{l.batchNo ?? "—"}</td>
            <td className={styles.num}>{qty(l.onHandAtCount)}</td>
            <td className={styles.num}>{l.countedQty === null ? "Not counted" : qty(l.countedQty)}</td>
            <td className={styles.num}>{l.difference === null ? "—" : <b>{signed(l.difference)}</b>}</td>
            <td className={styles.num}>{qty(l.now)}</td>
            <td className={styles.num}>{qty(l.afterPost)}</td>
            {showCost && <td className={styles.num}>{l.valueAtCost === null ? "—" : signedRs(l.valueAtCost)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `stk-confirm`: the totals before anything posts. Ctrl+Enter posts, Esc goes back. */
function ConfirmSheet({
  detail,
  posting,
  onPost,
  onCancel,
}: {
  detail: CounterWorkStocktakeDetail;
  posting: boolean;
  onPost: () => void;
  onCancel: () => void;
}) {
  const s = stocktakeSummary(detail);
  const ref = useRef<HTMLElement>(null);
  // Focus moves into the sheet, so Tab starts on its buttons rather than the page behind it.
  useEffect(() => ref.current?.focus(), []);
  useKeyBinding("Ctrl+Enter", onPost, { enabled: !posting });
  useKeyBinding("Escape", onCancel, { enabled: !posting });
  const title = [detail.reference, detail.subject].filter(Boolean).join(" · ");
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className={styles.sheet}
      role="dialog"
      aria-modal="true"
      aria-labelledby="stk-confirm-title"
    >
      <div>
        <b id="stk-confirm-title">Post stock count {detail.reference}?</b>
        <small className={styles.hint}>
          {title} · {plural(s.differences, "adjustment")}
        </small>
      </div>
      <p>
        {s.differences === 0 ? (
          <>Writes no adjustments: every counted line matched. The count closes as it is.</>
        ) : (
          <>
            Writes <b>{plural(s.differences, "adjustment")}</b>
            {s.valueAtCost !== null && (
              <>
                , <b>{signedRs(s.valueAtCost)}</b> at cost
              </>
            )}
            , to {plural(s.differences, "batch", "batches")}. The other {plural(s.unchanged, "line")} stay as they
            are, and sales since the count are kept.
          </>
        )}
      </p>
      <ul className={styles.checks}>
        <li>
          <Icon name="check" />
          Matches the version {detail.approved?.name ?? "the approver"} approved
        </li>
        <li>
          <Icon name={s.uncounted ? "info" : "check"} />
          {s.uncounted
            ? `${plural(s.uncounted, "line")} ${s.uncounted === 1 ? "wasn't" : "weren't"} counted; posting leaves ${s.uncounted === 1 ? "it" : "them"} as ${s.uncounted === 1 ? "it is" : "they are"}`
            : `All ${plural(s.lines, "line")} have a count`}
        </li>
      </ul>
      <p className={styles.hint}>Posting can't be undone. A later correction is a new count or a stock adjustment.</p>
      <div className={styles.actions}>
        <button type="button" className={cx(ui.btn, ui.outline)} disabled={posting} onClick={onCancel}>
          Cancel
          <KeyHint keys="Escape" small />
        </button>
        <button type="button" className={cx(ui.btn, ui.primary)} disabled={posting} onClick={onPost}>
          {posting ? "Posting…" : s.differences ? `Post ${plural(s.differences, "adjustment")}` : "Post stock count"}
          <KeyHint keys="Ctrl+Enter" onPrimary small />
        </button>
      </div>
    </section>
  );
}

/**
 * `stk` Post stock count. Counted on phones and reviewed on the web; the counter posts the
 * approved differences as found at the count (decision 3), applied to stock as it is now, so sales
 * and deliveries since the count stay. The counter never edits a count. Posting needs the approval
 * to match: there is no waiver for a stocktake.
 */
export function StocktakeBody({
  detail,
  online,
  canPost,
  onPosted,
  onRefused,
}: {
  detail: CounterWorkStocktakeDetail;
  online: boolean;
  /** Nothing else at this counter is waiting to be confirmed. */
  canPost: boolean;
  onPosted: () => void;
  /** Read the count again: the approval or the count moved on. */
  onRefused: () => void;
}) {
  const s = stocktakeSummary(detail);
  const [view, setView] = useState<View>(s.differences ? "differences" : "all");
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  const ready =
    detail.approval.state === "matches" && detail.approval.evidenceId !== null && online && canPost && !posted;
  const showCost = detail.lines.some((l) => l.valueAtCost !== null) || s.valueAtCost !== null;
  const inView = view === "differences" ? detail.lines.filter(isDifference) : detail.lines;
  const [limit, setLimit] = useState(STOCKTAKE_PAGE);
  const shown = inView.length > limit ? inView.slice(0, limit) : inView;

  // The sheet promises "matches the version … approved"; once that stops being true (a re-read
  // brought a changed or withdrawn approval, the counter went offline, an action is waiting),
  // the sheet closes rather than leaving a Post button that does nothing.
  useEffect(() => {
    if (!ready) setConfirming(false);
  }, [ready]);

  useKeyBinding("Ctrl+Enter", () => setConfirming(true), { enabled: ready && !confirming });

  const showView = (next: View) => {
    setView(next);
    setLimit(STOCKTAKE_PAGE);
  };

  const post = async () => {
    if (!ready || posting) return;
    setPosting(true);
    setError(null);
    const result = await invoke(() => window.pos.postCounterStocktake({ id: detail.id }));
    setPosting(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.error.message);
      onRefused();
      return;
    }
    const v = result.value;
    setPosted(
      v.alreadyApplied
        ? `Already posted. ${v.reference} was posted before.`
        : `Posted. ${v.reference}: ${plural(s.differences, "adjustment")} written.`,
    );
    onPosted();
  };

  return (
    <>
      <div className={styles.facts}>
        <span>
          <Icon name="clipboard-list" />
          {plural(s.lines - s.uncounted, "line")} counted
        </span>
        <span>{plural(s.differences, "difference")}</span>
        {s.valueAtCost !== null && <span>{signedRs(s.valueAtCost)} at cost</span>}
      </div>
      {detail.approval.state === "matches" && (
        <p className={styles.hint}>
          Matches the approved version. The differences are what was found at the count, so today's sales and
          deliveries stay as they are.
        </p>
      )}
      <div className={ui.seg} role="group" aria-label="Show lines">
        <button type="button" aria-pressed={view === "differences"} onClick={() => showView("differences")}>
          Differences <i>{s.differences}</i>
        </button>
        <button type="button" aria-pressed={view === "all"} onClick={() => showView("all")}>
          All lines <i>{s.lines}</i>
        </button>
      </div>
      {shown.length ? (
        <>
          <StocktakeLines lines={shown} showCost={showCost} />
          {inView.length > shown.length && (
            <div className={styles.actions}>
              <small className={styles.hint}>
                Showing {qty(shown.length)} of {plural(inView.length, "line")}.
              </small>
              <button
                type="button"
                className={cx(ui.btn, ui.outline)}
                onClick={() => setLimit((n) => n + STOCKTAKE_PAGE)}
              >
                Show {qty(Math.min(STOCKTAKE_PAGE, inView.length - shown.length))} more
              </button>
            </div>
          )}
        </>
      ) : (
        <p className={styles.hint}>Every counted line matched what was on hand at the count.</p>
      )}
      <div className={cx(ui.note, styles.waiting)} role="note">
        <Icon name="info" />
        <div>
          Posting writes {plural(s.differences, "adjustment")} and leaves the other {plural(s.unchanged, "line")} as
          they are. Each Difference is applied to Now, so sales since the count stay.
          {s.uncounted > 0 && ` ${plural(s.uncounted, "line")} ${s.uncounted === 1 ? "wasn't" : "weren't"} counted and stay as they are.`}
        </div>
      </div>

      {posted && (
        <p className={ui.okText} role="status">
          {posted}
        </p>
      )}
      {error && (
        <p role="alert" className={ui.badText}>
          {error}
        </p>
      )}

      {confirming && !posted && (
        <KeyScope layer>
          <ConfirmSheet
            detail={detail}
            posting={posting}
            onPost={() => void post()}
            onCancel={() => setConfirming(false)}
          />
        </KeyScope>
      )}

      {!posted && !confirming && (
        <div className={styles.actions}>
          <small className={styles.hint}>
            {!online
              ? "Posting needs the server. This counter is offline."
              : !canPost
                ? "Confirm the action waiting at this counter first."
                : detail.approval.state !== "matches"
                  ? "Posting is off until this count is approved again on the web."
                  : "You check the totals before anything posts."}
          </small>
          <button
            type="button"
            className={cx(ui.btn, ui.primary)}
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            <Icon name="clipboard-list" />
            Post stock count
            <KeyHint keys="Ctrl+Enter" onPrimary small />
          </button>
        </div>
      )}
    </>
  );
}
