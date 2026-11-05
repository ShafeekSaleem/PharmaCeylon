import { useEffect, useRef, useState, type RefObject } from "react";
import type { ApproverView } from "../../shared/ipc-contract";
import d from "./Dispensing.module.css";
import x from "./Discount.module.css";
import { Icon } from "./Icon";
import { invoke, moneyInput } from "./invoke";
import { KeyHint } from "./KeyHint";
import { inField, useKeyBinding } from "./keymap";
import {
  discountFromInput,
  discountPercent,
  money,
  overDiscountLimit,
  percentText,
  type DiscountMode,
} from "./sell-model";
import { Avatar } from "./Shell";
import ui from "./ui.module.css";
import { cx } from "./useAction";

/** How a line's discount was typed, so a percent keeps its meaning when the quantity changes. */
export type LineDiscount = { mode: DiscountMode; value: string };

/** Who approves the sale's discounts over the limit: a manager with their PIN, or the seller. */
export type DiscountApprover = { kind: "manager"; userId: string; name: string } | { kind: "self" } | null;

export type DiscountLineView = {
  productId: string;
  name: string;
  qty: number;
  unit: string | null;
  unitPriceMinor: number;
  discount: LineDiscount | null;
};

/**
 * The managers who can approve a discount over the limit, and the one chosen entering their own
 * PIN, the way the prescription sheet takes the pharmacist's. Or the seller approving it under
 * their own authority, which the server allows only when their role may.
 */
function Approvers({
  approver,
  pin,
  onApprover,
  onPin,
  pinRef,
}: {
  approver: DiscountApprover;
  pin: string;
  onApprover: (approver: DiscountApprover) => void;
  onPin: (pin: string) => void;
  pinRef: RefObject<HTMLInputElement>;
}) {
  const [approvers, setApprovers] = useState<ApproverView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void invoke(() => window.pos.listDiscountApprovers()).then((result) => {
      if (result.ok) setApprovers(result.value);
      else setError(result.error.message);
    });
  }, []);

  return (
    <div className={d.list} id="discount-approvers">
      <div className={d.subH}>
        Manager approval <span>over the limit</span>
      </div>
      {approvers?.length === 0 && (
        <p className={ui.muted}>
          Nobody else here can approve discounts over the limit.
        </p>
      )}
      {approvers?.map((a) => {
        const on = approver?.kind === "manager" && approver.userId === a.userId;
        const state = a.hasPin
          ? "Approves with their PIN"
          : "No PIN yet, approves with their login password";
        if (!on)
          return (
            <button
              key={a.userId}
              type="button"
              className={d.pharm}
              onClick={() => onApprover({ kind: "manager", userId: a.userId, name: a.fullName })}
            >
              <Avatar id={a.userId} name={a.fullName} className={d.av} />
              <div>
                <b>{a.fullName}</b>
                <small>{state}</small>
              </div>
            </button>
          );
        const digits = Math.max(6, pin.length);
        return (
          <div key={a.userId} className={cx(d.pharm, d.pharmOn)}>
            <Avatar id={a.userId} name={a.fullName} className={d.av} />
            <div>
              <b>{a.fullName}</b>
              <small>{state}</small>
            </div>
            <div className={d.pinMini}>
              <span>
                {a.hasPin ? "Manager's PIN" : "Their login password"}
                <KeyHint keys="F9" small />
              </span>
              {a.hasPin ? (
                <div className={d.dots}>
                  {Array.from({ length: digits }, (_, i) => (
                    <i key={i} className={i < pin.length ? d.f : undefined} />
                  ))}
                  <input
                    ref={pinRef}
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label={`${a.fullName}'s PIN`}
                    value={pin}
                    maxLength={8}
                    onChange={(e) => onPin(e.target.value.replace(/\D/g, ""))}
                  />
                </div>
              ) : (
                <input
                  ref={pinRef}
                  type="password"
                  autoComplete="off"
                  className={cx(ui.in, d.password)}
                  aria-label={`${a.fullName}'s login password`}
                  value={pin}
                  maxLength={128}
                  onChange={(e) => onPin(e.target.value)}
                />
              )}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className={cx(d.pharm, approver?.kind === "self" && d.pharmOn)}
        onClick={() => onApprover({ kind: "self" })}
        aria-pressed={approver?.kind === "self"}
      >
        <span className={d.selfIcon}>
          <Icon name="user" />
        </span>
        <div>
          <b>I&apos;m approving it myself</b>
          <small>Only if your role may approve discounts over the limit.</small>
        </div>
      </button>
      {error && (
        <p role="alert" className={ui.badText}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The line discount sheet over Sell (F9). Up to the branch's limit anyone selling gives it; above
 * it a manager approves with their own PIN on this counter. Nothing is decided here: the server
 * reads the limit and checks the approver at checkout, and a refusal comes back to this sheet.
 * One manager's approval covers every line of the sale that is over the limit.
 */
export function DiscountSheet({
  line,
  limitPercent,
  approver,
  pin,
  refusal,
  pinRef,
  onApply,
  onApprover,
  onPin,
  onClose,
}: {
  line: DiscountLineView;
  limitPercent: number;
  approver: DiscountApprover;
  pin: string;
  /** Checkout's refusal of the discount approval, if it was refused. */
  refusal: string | null;
  pinRef: RefObject<HTMLInputElement>;
  onApply: (discount: LineDiscount | null) => void;
  onApprover: (approver: DiscountApprover) => void;
  onPin: (pin: string) => void;
  onClose: () => void;
}) {
  const grossMinor = line.unitPriceMinor * line.qty;
  const [mode, setMode] = useState<DiscountMode>(line.discount?.mode ?? "percent");
  const [value, setValue] = useState(line.discount?.value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);

  const discountMinor = discountFromInput(mode, value, grossMinor);
  const invalid = value.trim() !== "" && discountMinor === null;
  const over = discountMinor !== null && overDiscountLimit(discountMinor, grossMinor, limitPercent);
  const approved = !over || approver?.kind === "self" || (approver?.kind === "manager" && pin.length >= 4);
  const ready = discountMinor !== null && approved;

  // The sheet takes the cursor when it opens, so the keyboard works in it.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  // Choosing a manager puts their PIN under their fingers.
  const managerId = approver?.kind === "manager" ? approver.userId : null;
  useEffect(() => {
    if (managerId) pinRef.current?.focus();
  }, [managerId, pinRef]);

  function apply() {
    if (!ready) return;
    onApply(discountMinor === 0 ? null : { mode, value: value.trim() });
  }

  // Keys (keymap.ts; this sheet is a layer, so Sell's own keys are quiet while it's open).
  useKeyBinding("Escape", () => onClose());
  // F9 again goes to the chosen manager's PIN, as the label beside it says; otherwise the amount.
  useKeyBinding("F9", () => {
    (pinRef.current ?? inputRef.current)?.focus();
  });
  // ↵ applies from the amount, the PIN or with nothing focused; Ctrl+Enter from anywhere.
  useKeyBinding(
    ["Enter", "Ctrl+Enter"],
    (event) => {
      if (!ready) return false;
      const target = event.target as Element | null;
      if (
        !event.ctrlKey &&
        target !== pinRef.current &&
        target !== inputRef.current &&
        (inField(target) || target?.closest?.("button, a, [role='button']"))
      )
        return false;
      apply();
    },
    { inFields: true },
  );

  const quick = [5, limitPercent].filter((p, i, all) => p > 0 && all.indexOf(p) === i).sort((a, b) => a - b);
  const percent = discountMinor === null ? 0 : discountPercent(discountMinor, grossMinor);

  return (
    <>
      <div className={d.scrim} onClick={onClose} aria-hidden="true" />
      <aside className={cx(d.sheet, x.sheet)} role="dialog" aria-modal="true" aria-labelledby="discount-sheet-title">
        <div className={d.head}>
          <span className={cx(ui.kind, d.kind, x.kind)}>
            <Icon name="tag" />
          </span>
          <div>
            <div className={ui.eyebrow}>
              Line discount · up to {percentText(limitPercent)} without a manager
            </div>
            <h2 id="discount-sheet-title">{line.name}</h2>
          </div>
          <span className={ui.grow} />
          <button type="button" className={cx(ui.btn, ui.ghost, d.close)} onClick={onClose} aria-label="Back to sale">
            <Icon name="x" />
          </button>
        </div>
        <div className={d.body}>
          {refusal && (
            <div role="alert" className={cx(ui.note, ui.noteBad)}>
              <Icon name="alert-triangle" />
              <span>{refusal}</span>
            </div>
          )}
          <div className={x.line}>
            <span>
              {line.qty}
              {line.unit ? ` ${line.unit}` : ""} × {money(line.unitPriceMinor)}
            </span>
            <b>Rs {money(grossMinor)}</b>
          </div>
          <div className={x.entry}>
            <div className={ui.seg} role="group" aria-label="Discount as">
              {(
                [
                  ["percent", "Percent"],
                  ["amount", "Amount"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={mode === id}
                  onClick={() => {
                    setMode(id);
                    setValue("");
                    inputRef.current?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={cx(x.amount, invalid && x.amountBad)}>
              {mode === "amount" && <small>Rs</small>}
              <input
                ref={inputRef}
                inputMode="decimal"
                autoComplete="off"
                aria-label={mode === "percent" ? "Discount percent" : "Discount amount"}
                aria-invalid={invalid}
                value={value}
                onChange={(e) => setValue(moneyInput(e.target.value))}
                placeholder="0"
              />
              {mode === "percent" && <small>%</small>}
            </div>
            <div className={x.quick}>
              {quick.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={mode === "percent" && Number(value) === p}
                  onClick={() => {
                    setMode("percent");
                    setValue(String(p));
                  }}
                >
                  {percentText(p)}
                  {p === limitPercent && <small>limit</small>}
                </button>
              ))}
            </div>
          </div>
          {invalid && (
            <p role="alert" className={ui.badText}>
              {mode === "percent" ? "Enter a percent from 0 to 100." : `Enter an amount up to ${money(grossMinor)}.`}
            </p>
          )}
          {discountMinor !== null && discountMinor > 0 && (
            <dl className={x.result}>
              <dt>Discount ({percentText(percent)})</dt>
              <dd className={x.neg}>−{money(discountMinor)}</dd>
              <dt>Line after discount</dt>
              <dd>Rs {money(grossMinor - discountMinor)}</dd>
            </dl>
          )}
          {over && (
            <>
              <div className={cx(ui.note, x.over)}>
                <Icon name="shield-check" />
                <span>
                  Over the {percentText(limitPercent)} limit, so a manager approves it with their own PIN on this
                  counter. Their approval covers this sale&apos;s other discounts too.
                </span>
              </div>
              <Approvers approver={approver} pin={pin} onApprover={onApprover} onPin={onPin} pinRef={pinRef} />
            </>
          )}
        </div>
        <div className={d.foot}>
          {line.discount && (
            <button type="button" className={cx(ui.btn, ui.ghost, ui.lg)} onClick={() => onApply(null)}>
              <Icon name="trash" />
              Remove discount
            </button>
          )}
          <span className={ui.grow} />
          <button type="button" className={cx(ui.btn, ui.outline, ui.lg)} onClick={onClose}>
            Back to sale <KeyHint keys="Escape" small />
          </button>
          <button
            ref={applyRef}
            type="button"
            className={cx(ui.btn, ui.primary, ui.lg)}
            onClick={apply}
            disabled={!ready}
          >
            <Icon name={over ? "shield-check" : "tag"} />
            {over && approver?.kind === "manager" ? "Approve and apply" : "Apply discount"}
            <KeyHint keys="Enter" small onPrimary />
          </button>
        </div>
      </aside>
    </>
  );
}
