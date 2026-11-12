import type { ProductStock, StockBatch } from "../../shared/ipc-contract";
import d from "./Dispensing.module.css";
import { Icon } from "./Icon";
import { KeyScope, useKeyBinding } from "./keymap";
import { expiryLabel, productName, unitWord, writeOffCheck } from "./stock-model";
import qs from "./StockQuarantineSheet.module.css";
import type { CSSProperties } from "react";
import { money } from "./sell-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

/** wo-limit: direct write-off refused with WRITE_OFF_APPROVAL_REQUIRED (#173). */
export function WriteOffLimitSheet({
  product,
  batch,
  qty,
  onClose,
}: {
  product: ProductStock;
  batch: StockBatch;
  qty: number;
  onClose: () => void;
}) {
  useKeyBinding("Escape", onClose);
  const unit = product.product.unit;
  const check = writeOffCheck(batch, qty, product.writeOffLimit);
  const value = check.valueMinor !== null ? `Rs ${money(check.valueMinor)}` : "—";
  const limit =
    check.limitMinor !== null ? `Rs ${money(check.limitMinor)}` : "the write-off limit";

  return (
    <KeyScope layer>
      <div className={d.scrim} onClick={onClose} aria-hidden="true" />
      <aside className={d.sheet} role="dialog" aria-modal="true" aria-labelledby="wo-limit-title">
        <div className={d.head}>
          <span className={cx(ui.kind, d.kind)} style={{ "--c": "var(--pos-t-amber)" } as CSSProperties}>
            <Icon name="alert-triangle" />
          </span>
          <div>
            <div className={ui.eyebrow}>Stock · inventory.write_off</div>
            <h2 id="wo-limit-title">Write off needs approval</h2>
            <div className={qs.flags}>
              <span className={cx(ui.pill, ui.bad)}>WRITE_OFF_APPROVAL_REQUIRED</span>
              <span className={cx(ui.pill, ui.neutral)}>Online only</span>
            </div>
          </div>
          <button type="button" className={cx(ui.btn, ui.ghost, d.close)} onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className={d.body}>
          <div className={qs.batchCard}>
            <b>{productName(product.product)}</b>
            <span className={ui.mono}>{batch.batchNo}</span>
          </div>
          <div className={cx(ui.note, ui.warn)} role="alert">
            <Icon name="alert-triangle" />
            <div>
              <b>This write-off needs approval</b>
              {` ${qty} ${unitWord(unit, qty)} · ${value} is over the ${limit}, so a manager must accept it. The counter cannot hold the request — raise it on the web with POST /inventory/adjustment-requests. The server refuses this direct post with 409 WRITE_OFF_APPROVAL_REQUIRED and moves nothing. After accept, it appears in Counter work.`}
            </div>
          </div>
          <p className={qs.fixture}>Illustrative fixture — sample people, quantities, references and times.</p>
        </div>
        <div className={d.foot}>
          <span className={ui.grow} />
          <button type="button" className={cx(ui.btn, ui.outline, ui.lg)} onClick={onClose}>
            Close
          </button>
          <button type="button" className={cx(ui.btn, ui.primary, ui.lg)} disabled>
            Write off
          </button>
        </div>
      </aside>
    </KeyScope>
  );
}
