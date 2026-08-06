"use client";

import {
  IconBell,
  IconKeyboard,
  IconPause,
  IconPlus,
  IconRotateCcw,
  IconX,
} from "@/components/icons";
import css from "../pos.module.css";

type Props = {
  cartDirty: boolean;
  holdCount: number;
  busy: boolean;
  beepEnabled: boolean;
  /** When true (Returns mode), park/clear/new sale actions that touch the cart are disabled. */
  saleActionsDisabled?: boolean;
  onNewSale: () => void;
  onHold: () => void;
  onRecall: () => void;
  onClear: () => void;
  onShortcuts: () => void;
  onToggleBeep: () => void;
};

export function PosActionBar({
  cartDirty,
  holdCount,
  busy,
  beepEnabled,
  saleActionsDisabled = false,
  onNewSale,
  onHold,
  onRecall,
  onClear,
  onShortcuts,
  onToggleBeep,
}: Props) {
  return (
    <div className={css.actionGroup}>
      <button
        type="button"
        className={`${css.toolBtn} ${css.toolBtnPrimary}`}
        onClick={onNewSale}
        disabled={busy || saleActionsDisabled}
        data-tooltip="Start a fresh sale (F8)"
      >
        <IconPlus size={15} />
        New sale
      </button>
      <button
        type="button"
        className={css.toolBtn}
        onClick={onHold}
        disabled={busy || !cartDirty || saleActionsDisabled}
        data-tooltip="Park this cart and serve the next customer (F6)"
      >
        <IconPause size={15} />
        Hold
      </button>
      <button
        type="button"
        className={css.toolBtn}
        onClick={onRecall}
        disabled={busy || saleActionsDisabled}
        data-tooltip="Bring back a parked cart (F7)"
      >
        <IconRotateCcw size={15} />
        Recall
        {holdCount > 0 && <span className={css.holdCount}>{holdCount}</span>}
      </button>
      <button
        type="button"
        className={`${css.toolBtn} ${css.toolBtnDanger}`}
        onClick={onClear}
        disabled={busy || !cartDirty || saleActionsDisabled}
        data-tooltip="Empty the cart (Alt+X)"
      >
        <IconX size={15} />
        Clear
      </button>

      <span className={css.actionDivider} aria-hidden />

      <button
        type="button"
        className={css.iconBtn}
        onClick={onToggleBeep}
        aria-pressed={beepEnabled}
        data-tooltip={beepEnabled ? "Scan beep on" : "Scan beep off"}
      >
        <IconBell size={15} />
      </button>
      <button
        type="button"
        className={css.iconBtn}
        onClick={onShortcuts}
        data-tooltip="Keyboard shortcuts (?)"
      >
        <IconKeyboard size={15} />
      </button>
    </div>
  );
}
