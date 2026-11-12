import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ProductStock, StockBatch } from "../../shared/ipc-contract";
import d from "./Dispensing.module.css";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { KeyScope, useKeyBinding } from "./keymap";
import type { CSSProperties } from "react";
import {
  buildQuarantineBody,
  buildReleaseBody,
  mapStockCommandError,
  QUARANTINE_REASON_CODES,
  QUARANTINE_REASON_LABELS,
  type QuarantineReasonCode,
  quarantinePrimaryEnabled,
  releasePrimaryEnabled,
  type QuarantineForm,
  type QuarantineSheetMode,
} from "./stock-quarantine-model";
import qs from "./StockQuarantineSheet.module.css";
import { expiryLabel, expiryWhen, productName, unitWord } from "./stock-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";
import { P6_EXPIRY_REVIEW_OPENS_QUARANTINE_SHEET, P6_QUARANTINE_COUNTER_ONLY } from "./p6-config";

type Phase = "ready" | "confirm" | "processing" | "success";

export function StockQuarantineSheet({
  mode,
  product,
  batch,
  online,
  fromExpiryReview,
  onClose,
  onDone,
  onCommandSent,
}: {
  mode: QuarantineSheetMode;
  product: ProductStock;
  batch: StockBatch;
  online: boolean;
  fromExpiryReview?: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
  onCommandSent?: () => void;
}) {
  const quarantine = mode === "quarantine";
  const [perms, setPerms] = useState({ quarantine: true, releaseQuarantine: true, writeOff: true });
  const [phase, setPhase] = useState<Phase>("ready");
  const [banner, setBanner] = useState<{ tone: string; title: string; body: string } | null>(null);
  const [form, setForm] = useState<QuarantineForm>(() => ({
    qtyText: String(quarantine ? batch.available || 1 : batch.quarantined || 1),
    allQty: false,
    reasonCode: fromExpiryReview && P6_EXPIRY_REVIEW_OPENS_QUARANTINE_SHEET ? "expired" : "damaged",
    reasonText: "",
  }));
  const formRef = useRef<HTMLFormElement>(null);
  const unit = product.product.unit;

  useEffect(() => {
    void invoke(() => window.pos.stockPermissions()).then((r) => {
      if (r.ok) setPerms(r.value);
    });
  }, []);

  const hasPermission = quarantine ? perms.quarantine : perms.releaseQuarantine;

  useEffect(() => {
    if (!online) {
      setBanner({
        tone: ui.badText!,
        title: "Stock operations need the server",
        body: quarantine
          ? "Quarantine is not an offline journal command. The desktop posts only while terminalConnectivity is online."
          : "Release is not an offline journal command. Blocked while connectivity is not online.",
      });
      return;
    }
    if (!hasPermission) {
      setBanner({
        tone: ui.badText!,
        title: quarantine
          ? "You need inventory.quarantine"
          : "You need inventory.release_quarantine",
        body: "The server enforces this on prepare and execute (PERMISSION_DENIED).",
      });
      return;
    }
    if (quarantine && batch.available <= 0 && batch.onHand <= 0) {
      setBanner({
        tone: ui.warn!,
        title:
          batch.onHand <= 0
            ? "There is no stock on this batch to quarantine"
            : "Nothing left to quarantine — every unit on this batch is already held or reserved",
        body: "The signed command is refused before stock moves.",
      });
      return;
    }
    if (!quarantine && batch.quarantined <= 0) {
      setBanner({
        tone: ui.warn!,
        title: "Nothing is quarantined on this batch",
        body: "There are no held units to release.",
      });
      return;
    }
    if (!quarantine && batch.expired) {
      setBanner({
        tone: ui.badText!,
        title: `This batch expired on ${batch.expiryDate?.slice(0, 10) ?? "—"}. Expired stock can't go back on sale — write it off or return it to the supplier.`,
        body: "Refused before stock moves. Use write-off or a supplier return instead.",
      });
      return;
    }
    if (fromExpiryReview && P6_EXPIRY_REVIEW_OPENS_QUARANTINE_SHEET) {
      setBanner({
        tone: ui.warn!,
        title: "Opened from expiry review",
        body: "Daily work kind batch.expiry_review. This sheet opens with reasonCode: expired.",
      });
      return;
    }
    setBanner(null);
  }, [online, hasPermission, quarantine, batch, fromExpiryReview]);

  const primaryOk = quarantine
    ? quarantinePrimaryEnabled(form, batch, online, hasPermission)
    : releasePrimaryEnabled(form, batch, online, hasPermission);

  const submit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (phase === "processing") return;
      if (phase === "ready" && primaryOk) {
        setPhase("confirm");
        return;
      }
      if (phase !== "confirm") return;
      setPhase("processing");
      const body = quarantine
        ? buildQuarantineBody(batch.batchId, form, batch)
        : buildReleaseBody(batch.batchId, form);
      const result = await invoke(() =>
        quarantine
          ? window.pos.quarantineBatch(body as never)
          : window.pos.releaseQuarantine(body as never),
      );
      if (!result.ok) {
        setPhase("ready");
        const mapped = mapStockCommandError(result.error.code, result.error.message);
        if (mapped.kind === "permission") {
          setBanner({
            tone: ui.badText!,
            title: quarantine ? "You need inventory.quarantine" : "You need inventory.release_quarantine",
            body: result.error.message,
          });
        } else if (mapped.kind === "validation" || mapped.kind === "available" || mapped.kind === "nothing_left" || mapped.kind === "nothing_held" || mapped.kind === "expired") {
          setBanner({ tone: ui.badText!, title: mapped.message, body: result.error.message });
        } else if (mapped.kind === "server") {
          setBanner({
            tone: ui.badText!,
            title: quarantine ? "The server did not confirm the hold" : "The server did not confirm the release",
            body: "Sent but not confirmed. Retry the original pending command — don't start a new one.",
          });
        } else {
          setBanner({ tone: ui.badText!, title: "Couldn't complete", body: result.error.message });
        }
        return;
      }
      setPhase("success");
      onCommandSent?.();
      const units = `${result.value.qty} ${unitWord(unit, result.value.qty)}`;
      onDone(
        quarantine
          ? `Held ${units} of ${batch.batchNo} from sale.`
          : `Released ${units} of ${batch.batchNo} back to sale.`,
      );
    },
    [phase, primaryOk, quarantine, form, batch, unit, onCommandSent, onDone],
  );

  useKeyBinding("Escape", onClose);
  useKeyBinding("Ctrl+Enter", () => void submit(), {
    enabled: phase !== "processing" && (phase === "confirm" || (phase === "ready" && primaryOk)),
  });

  const title = quarantine ? "Quarantine batch" : "Release quarantine";
  const eyebrow = quarantine ? "Stock · inventory.quarantine" : "Stock · inventory.release_quarantine";
  const primaryLabel =
    phase === "success"
      ? "Done"
      : phase === "confirm"
        ? quarantine
          ? "Confirm quarantine"
          : "Confirm release"
        : quarantine
          ? "Quarantine"
          : "Release";

  return (
    <KeyScope layer>
      <div className={d.scrim} onClick={onClose} aria-hidden="true" />
      <aside
        className={d.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stock-q-sheet-title"
      >
        <div className={d.head}>
          <span className={cx(ui.kind, d.kind)} style={{ "--c": "var(--pos-t-amber)" } as CSSProperties}>
            <Icon name="alert-triangle" />
          </span>
          <div>
            <div className={ui.eyebrow}>{eyebrow}</div>
            <h2 id="stock-q-sheet-title">{title}</h2>
            <div className={qs.flags}>
              <span className={cx(ui.pill, ui.neutral)}>Online only</span>
              <span className={cx(ui.pill, ui.info)}>Signed command</span>
              {P6_QUARANTINE_COUNTER_ONLY && (
                <span className={cx(ui.pill, ui.warn)}>Counter only</span>
              )}
            </div>
          </div>
          <button type="button" className={cx(ui.btn, ui.ghost, d.close)} onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <form ref={formRef} className={d.body} onSubmit={submit}>
          <BatchMotionCard batch={batch} product={product} unit={unit} note={batchNote(batch, quarantine)} />
          <MotionField
            label="Quantity"
            code="qty"
            value={form.qtyText}
            disabled={form.allQty || phase !== "ready"}
            onChange={(v: string) => setForm((f) => ({ ...f, qtyText: v }))}
            hint={
              form.allQty
                ? quarantine
                  ? "All available to hold — signed body sends qty: null."
                  : "All held — signed body sends qty: null."
                : quarantine
                  ? "Units to hold. Or tick all available to send qty: null."
                  : "Units to release. Or tick all held to send qty: null."
            }
          />
          <label className={qs.checkRow}>
            <input
              type="checkbox"
              checked={form.allQty}
              disabled={phase !== "ready"}
              onChange={(e) => setForm((f) => ({ ...f, allQty: e.target.checked }))}
            />
            {quarantine ? "All available to hold" : "All held"}
          </label>
          {quarantine && (
            <div className={ui.f}>
              <MotionFieldLabel code="reasonCode" text="Reason code" />
              <div className={qs.reasons} role="radiogroup" aria-label="Reason code">
                {QUARANTINE_REASON_CODES.map((code) => (
                  <button
                    key={code}
                    type="button"
                    role="radio"
                    aria-checked={form.reasonCode === code}
                    className={cx(
                      qs.reason,
                      form.reasonCode === code && qs.reasonOn,
                      code === "other" && qs.reasonWide,
                    )}
                    disabled={phase !== "ready"}
                    onClick={() => setForm((f) => ({ ...f, reasonCode: code }))}
                  >
                    <span />
                    {QUARANTINE_REASON_LABELS[code as QuarantineReasonCode]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {quarantine && form.reasonCode === "other" && (
            <MotionField
              label="Reason"
              code="reason"
              multiline
              value={form.reasonText}
              disabled={phase !== "ready"}
              onChange={(v: string) => setForm((f) => ({ ...f, reasonText: v }))}
              hint="Required when reasonCode is other. Exact trimmed text, max 512."
              invalid={!form.reasonText.trim() && phase !== "success"}
              invalidText="Describe why the stock is being held"
            />
          )}
          {!quarantine && (
            <MotionField
              label="Reason (optional)"
              code="reason"
              multiline
              value={form.reasonText}
              disabled={phase !== "ready"}
              onChange={(v: string) => setForm((f) => ({ ...f, reasonText: v }))}
              hint="Exact trimmed text, max 512, or null. No reasonCode on release."
            />
          )}
          {phase === "confirm" && (
            <div className={cx(ui.note, ui.warn)} role="status">
              <Icon name="alert-triangle" />
              <div>
                <b>{quarantine ? "Confirm hold from sale" : "Confirm return to sale"}</b>
                {quarantine
                  ? ` Units will be held with reasonCode ${form.reasonCode}. approvalEvidenceId is always null.`
                  : " Units will become sellable again."}
              </div>
            </div>
          )}
          {phase === "processing" && (
            <div className={cx(ui.note, ui.info)} role="status">
              <Icon name="clock" />
              <div>
                <b>{quarantine ? "Holding stock…" : "Releasing stock…"}</b>
                The signed command is in flight. Don't send a second command.
              </div>
            </div>
          )}
          {phase === "success" && (
            <div className={cx(ui.note, ui.ok)} role="status">
              <Icon name="check-circle" />
              <div>
                <b>{quarantine ? "Held from sale" : "Returned to sale"}</b>
                Result {quarantine ? "batch.quarantined" : "batch.quarantine_released"}. A retry of the same command replays this receipt.
              </div>
            </div>
          )}
          {banner && phase === "ready" && (
            <div className={cx(ui.note, banner.tone)} role="alert">
              <Icon name="alert-triangle" />
              <div>
                <b>{banner.title}</b>
                {banner.body}
              </div>
            </div>
          )}
          <p className={qs.fixture}>Illustrative fixture — sample people, quantities, references and times.</p>
        </form>
        <div className={d.foot}>
          <div className={qs.focusOrder}>
            <b>Focus order:</b> Quantity → {quarantine ? "All available → Reason code → Reason (if Other)" : "All held → Reason (optional)"} → Close → Cancel → {quarantine ? "Quarantine" : "Release"}. Esc closes.
          </div>
          <span className={ui.grow} />
          <button type="button" className={cx(ui.btn, ui.outline, ui.lg)} onClick={onClose}>
            {phase === "success" ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            className={cx(ui.btn, ui.primary, ui.lg)}
            disabled={phase === "processing" || phase === "success" || (phase === "ready" && !primaryOk)}
            onClick={() => void submit()}
          >
            {phase === "processing" ? "Posting…" : primaryLabel}
            {phase === "confirm" && <KeyHint keys="Ctrl+Enter" onPrimary spaced />}
          </button>
        </div>
      </aside>
    </KeyScope>
  );
}

function batchNote(batch: StockBatch, quarantine: boolean): string {
  if (batch.nearExpiry && batch.daysToExpiry !== null)
    return expiryWhen(batch.daysToExpiry);
  if (!quarantine && batch.quarantined > 0) return `${batch.quarantined} tabs held`;
  return "—";
}

function BatchMotionCard({
  batch,
  product,
  unit,
  note,
}: {
  batch: StockBatch;
  product: ProductStock;
  unit: string | null;
  note: string;
}) {
  return (
    <div className={qs.batchCard}>
      <b>{productName(product.product)}</b>
      <span className={ui.mono}>{batch.batchNo}</span>
      <div className={qs.kv}>
        <div>
          <small>Expiry</small>
          <b>{expiryLabel(batch.expiryDate, batch.nearExpiry)}</b>
        </div>
        <div>
          <small>On hand</small>
          <b>
            {batch.onHand} {unitWord(unit, batch.onHand)}
          </b>
        </div>
        <div>
          <small>Available</small>
          <b>
            {batch.available} {unitWord(unit, batch.available)}
          </b>
        </div>
        <div>
          <small>Reserved</small>
          <b>{batch.reserved || "0"}</b>
        </div>
        <div>
          <small>Quarantined</small>
          <b>{batch.quarantined || "0"}</b>
        </div>
        <div>
          <small>Note</small>
          <b>{note}</b>
        </div>
      </div>
    </div>
  );
}

function MotionFieldLabel({ code, text }: { code: string; text: string }) {
  return (
    <label>
      {text} <span className={ui.mono}>{code}</span>
    </label>
  );
}

function MotionField({
  label,
  code,
  value,
  onChange,
  hint,
  multiline,
  disabled,
  invalid,
  invalidText,
}: {
  label: string;
  code: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  multiline?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  invalidText?: string;
}) {
  return (
    <div className={ui.f}>
      <MotionFieldLabel code={code} text={label} />
      {multiline ? (
        <textarea
          className={cx(ui.in, invalid && ui.invalid)}
          value={value}
          disabled={disabled}
          maxLength={512}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={cx(ui.in, invalid && ui.invalid)}
          inputMode="numeric"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {invalid && invalidText ? (
        <span className={ui.badText}>{invalidText}</span>
      ) : hint ? (
        <span style={{ fontSize: 12, color: "var(--pos-text-3)" }}>{hint}</span>
      ) : null}
    </div>
  );
}
