import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type {
  ApproverView,
  CustomerView,
  PrescriptionView,
} from "../../shared/ipc-contract";
import d from "./Dispensing.module.css";
import { dayMonthYear } from "./format";
import { Icon } from "./Icon";
import { KeyHint } from "./KeyHint";
import { inField, useKeyBinding } from "./keymap";
import { invoke } from "./invoke";
import { issuedAgo, slmcRefusal, type SlmcRefusal } from "./sell-model";
import { Avatar } from "./Shell";
import ui from "./ui.module.css";
import { cx } from "./useAction";

/** Today on this computer's calendar: a prescription written this morning in Colombo is dated
 * today, though UTC may still be yesterday. */
const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const longDate = (iso: string) => dayMonthYear(new Date(`${iso}T00:00:00`));

/** A line on the sale that needs a prescription, as the sheet lists it. */
export type RxLine = {
  productId: string;
  name: string;
  qty: number;
  unit: string | null;
};

function RefusalNote({
  refusal,
  onChoosePharmacist,
  onHold,
}: {
  refusal: SlmcRefusal;
  onChoosePharmacist?: () => void;
  onHold: () => void;
}) {
  return (
    <div role="alert" className={cx(ui.note, ui.noteBad, d.refusal)}>
      <div>
        <Icon name="alert-triangle" />
        <div>
          <b>{refusal.title}</b>
          <p>{refusal.detail}</p>
          <p>{refusal.next}</p>
        </div>
      </div>
      <div className={d.refusalActions}>
        {refusal.actions.includes("choose-pharmacist") &&
          onChoosePharmacist && (
            <button
              type="button"
              className={cx(ui.btn, ui.outline, ui.sm)}
              onClick={onChoosePharmacist}
            >
              Choose a pharmacist
            </button>
          )}
        {refusal.actions.includes("hold") && (
          <button
            type="button"
            className={cx(ui.btn, ui.outline, ui.sm)}
            onClick={onHold}
          >
            <Icon name="pause" />
            Hold this sale
          </button>
        )}
      </div>
    </div>
  );
}

function RecordPrescription({
  customer,
  onRecorded,
  onFind,
  onCommandSent,
  onHold,
}: {
  customer: CustomerView | null;
  onRecorded: (prescription: PrescriptionView) => void;
  onFind: () => void;
  /** Recording is a signed command; one left unconfirmed waits at the counter to be confirmed. */
  onCommandSent?: () => void;
  onHold: () => void;
}) {
  const [patientName, setPatientName] = useState(customer?.fullName ?? "");
  const [doctorName, setDoctorName] = useState("");
  const [doctorRegNo, setDoctorRegNo] = useState("");
  const [issuedOn, setIssuedOn] = useState(today());
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SlmcRefusal | null>(null);
  const fromCustomer = Boolean(customer) && patientName === customer?.fullName;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const result = await invoke(() =>
        window.pos.recordPrescription({
          patientName,
          doctorName,
          issuedOn,
          ...(doctorRegNo.trim() ? { doctorRegNo } : {}),
          ...(validUntil ? { validUntil } : {}),
          ...(notes.trim() ? { notes } : {}),
          ...(customer ? { customerId: customer.customerId } : {}),
        }),
      );
      if (result.ok) onRecorded(result.value);
      else if (result.error.code === "PHARMACIST_REQUIRED")
        setRefusal(slmcRefusal("PHARMACIST_REQUIRED", result.error.message));
      else setError(result.error.message);
    } finally {
      setBusy(false);
      // Show a command left unconfirmed straight away, with its confirm button.
      onCommandSent?.();
    }
  }

  return (
    <form className={d.form} onSubmit={save} aria-label="Record prescription">
      <div className={ui.f}>
        <label htmlFor="rx-patient">
          Patient
          {fromCustomer && (
            <span className={cx(ui.pill, ui.brand, d.fromCustomer)}>
              From customer
            </span>
          )}
        </label>
        <input
          id="rx-patient"
          className={ui.in}
          value={patientName}
          onChange={(e) => setPatientName(e.target.value)}
          required
          minLength={2}
          maxLength={160}
        />
      </div>
      <div className={ui.f}>
        <span className={ui.label}>Prescription no.</span>
        <span className={d.assigned}>Numbered when it&apos;s saved</span>
      </div>
      <div className={ui.f}>
        <label htmlFor="rx-doctor">Doctor</label>
        <input
          id="rx-doctor"
          className={ui.in}
          value={doctorName}
          onChange={(e) => setDoctorName(e.target.value)}
          required
          minLength={2}
          maxLength={160}
        />
      </div>
      <div className={ui.f}>
        <label htmlFor="rx-slmc" className={ui.label}>
          SLMC reg. no. <span>optional</span>
        </label>
        <input
          id="rx-slmc"
          className={ui.in}
          value={doctorRegNo}
          onChange={(e) => setDoctorRegNo(e.target.value)}
          maxLength={64}
        />
      </div>
      <div className={ui.f}>
        <label htmlFor="rx-issued">Issued on</label>
        <input
          id="rx-issued"
          className={ui.in}
          type="date"
          value={issuedOn}
          max={today()}
          onChange={(e) => setIssuedOn(e.target.value)}
          required
        />
      </div>
      <div className={ui.f}>
        <label htmlFor="rx-valid" className={ui.label}>
          Valid until <span>optional</span>
        </label>
        <input
          id="rx-valid"
          className={ui.in}
          type="date"
          value={validUntil}
          min={issuedOn}
          onChange={(e) => setValidUntil(e.target.value)}
        />
      </div>
      <div className={cx(ui.f, d.wide)}>
        <label htmlFor="rx-notes" className={ui.label}>
          Notes <span>optional</span>
        </label>
        <input
          id="rx-notes"
          className={ui.in}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={512}
        />
      </div>
      <div className={cx(d.formActions, d.wide)}>
        <button
          type="submit"
          className={cx(ui.btn, ui.outline)}
          disabled={busy}
        >
          <Icon name="check" />
          {busy ? "Saving…" : "Save prescription"}
        </button>
        <button type="button" className={cx(ui.btn, ui.ghost)} onClick={onFind}>
          <Icon name="search" />
          Find one on file
        </button>
      </div>
      {refusal && (
        <div className={d.wide}>
          <RefusalNote refusal={refusal} onHold={onHold} />
        </div>
      )}
      {error && (
        <p role="alert" className={cx(ui.badText, d.wide)}>
          {error}
        </p>
      )}
    </form>
  );
}

function FindPrescription({
  customer,
  onChange,
  onRecord,
}: {
  customer: CustomerView | null;
  onChange: (prescription: PrescriptionView) => void;
  onRecord: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PrescriptionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A chosen customer's own prescriptions are the likely ones; show them without a search.
  useEffect(() => {
    if (!customer) return;
    void invoke(() =>
      window.pos.searchPrescriptions({ customerId: customer.customerId }),
    ).then((result) => setFound(result.ok ? result.value : []));
  }, [customer]);

  async function search(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const result = await invoke(() =>
      window.pos.searchPrescriptions({
        ...(query.trim() ? { q: query } : {}),
      }),
    );
    if (result.ok) setFound(result.value);
    else setError(result.error.message);
  }

  return (
    <div className={d.list}>
      <form className={d.search} onSubmit={search} role="search">
        <input
          className={ui.in}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rx number, patient or doctor"
          aria-label="Find a prescription"
        />
        <button type="submit" className={cx(ui.btn, ui.outline, ui.lg)}>
          <Icon name="search" />
          Find
        </button>
        <button
          type="button"
          className={cx(ui.btn, ui.ghost, ui.lg)}
          onClick={onRecord}
        >
          <Icon name="plus" />
          Record new
        </button>
      </form>
      {found && (
        <div className={d.subH}>
          {customer && !query.trim()
            ? `On file for ${customer.fullName}`
            : "Found"}
          <span>{found.length}</span>
        </div>
      )}
      {found?.length === 0 && (
        <p className={ui.muted}>
          Nothing on file. Record the paper prescription instead.
        </p>
      )}
      {found?.map((rx) => (
        <button
          key={rx.prescriptionId}
          type="button"
          className={d.cv}
          onClick={() => onChange(rx)}
          disabled={rx.expired}
        >
          <b className={ui.mono}>{rx.rxNumber}</b>
          <span>
            {rx.patientName} · Dr {rx.doctorName}
          </span>
          <span className={d.q}>
            {rx.expired ? "Expired" : longDate(rx.issuedOn)}
          </span>
        </button>
      ))}
      {error && (
        <p role="alert" className={ui.badText}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Who dispenses the controlled items: a pharmacist on this counter with their own PIN (or login
 * password, if they have no PIN), or the person signed in. The server checks the PIN and the
 * co-signer's SLMC registration at checkout.
 */
function Pharmacist({
  approverId,
  pin,
  onApprover,
  onPin,
  pinRef,
  refusedIds,
}: {
  approverId: string;
  pin: string;
  onApprover: (id: string, name?: string) => void;
  onPin: (pin: string) => void;
  pinRef: RefObject<HTMLInputElement>;
  refusedIds: string[];
}) {
  const [approvers, setApprovers] = useState<ApproverView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void invoke(() => window.pos.listApprovers()).then((result) => {
      if (result.ok) setApprovers(result.value);
      else setError(result.error.message);
    });
  }, []);

  return (
    <div className={d.list} id="rx-pharmacists">
      <div className={d.subH}>
        Pharmacist check <span>controlled medicines</span>
      </div>
      {approvers.map((a) => {
        const on = a.userId === approverId;
        const refused = refusedIds.includes(a.userId);
        const state = refused
          ? "No current SLMC registration at this branch"
          : a.hasPin
            ? "Pharmacist · co-signs with their PIN"
            : "Pharmacist · no PIN yet, co-signs with their login password";
        if (!on)
          return (
            <button
              key={a.userId}
              type="button"
              className={cx(d.pharm, refused && d.pharmRefused)}
              onClick={() => onApprover(a.userId, a.fullName)}
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
                {a.hasPin ? "Pharmacist's PIN" : "Their login password"}
                <KeyHint keys="F10" small />
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
        className={cx(d.pharm, !approverId && d.pharmOn)}
        onClick={() => onApprover("")}
        aria-pressed={!approverId}
      >
        <span className={d.selfIcon}>
          <Icon name="user" />
        </span>
        <div>
          <b>I&apos;m dispensing these myself</b>
          <small>
            Only if you have a current SLMC registration at this branch.
          </small>
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
 * The prescription sheet over Sell (screen=rxa). The cashier links a prescription on file or
 * records the paper one, and a pharmacist co-signs controlled items with their own PIN on this
 * counter. Nothing is checked here: the server re-checks the prescription, its expiry, the PIN and
 * the dispenser's SLMC registration at checkout, and refusals come back to this sheet.
 */
export function PrescriptionSheet({
  rxLines,
  hasControlled,
  customer,
  prescription,
  approverId,
  pin,
  refusal,
  refusedApproverIds,
  pinRef,
  totalText,
  onPrescription,
  onApprover,
  onPin,
  onCommandSent,
  onHold,
  onClose,
  onContinue,
}: {
  rxLines: RxLine[];
  hasControlled: boolean;
  customer: CustomerView | null;
  prescription: PrescriptionView | null;
  approverId: string;
  pin: string;
  /** Checkout's SLMC refusal for this sale, if it was refused. */
  refusal: SlmcRefusal | null;
  refusedApproverIds: string[];
  pinRef: RefObject<HTMLInputElement>;
  totalText: string;
  onPrescription: (prescription: PrescriptionView | null) => void;
  onApprover: (id: string, name?: string) => void;
  onPin: (pin: string) => void;
  onCommandSent?: () => void;
  onHold: () => void;
  onClose: () => void;
  onContinue: () => void;
}) {
  const [mode, setMode] = useState<"find" | "record">(
    customer ? "find" : "record",
  );
  const detailsDone = Boolean(prescription && !prescription.expired);
  const checkDone = !hasControlled || !approverId || pin.length >= 4;
  const ready = detailsDone && checkDone;
  const current = !detailsDone ? 1 : !checkDone ? 2 : 3;
  const who = customer?.fullName ?? prescription?.patientName ?? null;

  // The sheet takes the cursor when it opens, so the keyboard works in it: its first field, or the
  // main button. (Sell then moves it to the PIN when a pharmacist is already chosen.)
  const bodyRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const field = bodyRef.current?.querySelector<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    (field ?? continueRef.current)?.focus();
  }, []);

  // Keys (keymap.ts; this sheet is a layer, so Sell's own keys are quiet while it's open).
  useKeyBinding("Escape", () => onClose());
  // F10 puts the cursor in the chosen pharmacist's PIN, as the label beside it says.
  useKeyBinding("F10", () => {
    if (!pinRef.current) return false;
    pinRef.current.focus();
  });
  // ↵ continues, from the PIN or with nothing focused: anywhere else Enter keeps its own job
  // (a button presses, a form submits). Ctrl+Enter continues from anywhere.
  useKeyBinding(
    ["Enter", "Ctrl+Enter"],
    (event) => {
      if (!ready) return false;
      const target = event.target as Element | null;
      if (
        !event.ctrlKey &&
        target !== pinRef.current &&
        (inField(target) || target?.closest?.("button, a, [role='button']"))
      )
        return false;
      onContinue();
    },
    { inFields: true },
  );

  const step = (n: number, label: string) => (
    <span
      className={cx(d.ms, n < current && d.isDone, n === current && d.isNow)}
      aria-current={n === current ? "step" : undefined}
    >
      <i>{n < current ? <Icon name="check" /> : n}</i>
      {label}
    </span>
  );

  return (
    <>
      <div className={d.scrim} onClick={onClose} aria-hidden="true" />
      <aside
        className={d.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rx-sheet-title"
      >
        <div className={d.head}>
          <span className={cx(ui.kind, d.kind)}>
            <Icon name="pill" />
          </span>
          <div>
            <div className={ui.eyebrow}>
              {rxLines.length} item{rxLines.length === 1 ? "" : "s"} on this
              sale need{rxLines.length === 1 ? "s" : ""} a prescription
            </div>
            <h2 id="rx-sheet-title">
              {who ? `Prescription for ${who}` : "Prescription for this sale"}
            </h2>
          </div>
          <span className={ui.grow} />
          <button
            type="button"
            className={cx(ui.btn, ui.ghost, d.close)}
            onClick={onClose}
            aria-label="Back to sale"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className={d.steps}>
          {step(1, "Prescription details")}
          <span className={d.msLine} />
          {step(2, hasControlled ? "Pharmacist check" : "No co-sign needed")}
          <span className={d.msLine} />
          {step(3, "Payment")}
        </div>
        <div className={d.body} ref={bodyRef}>
          {refusal && (
            <RefusalNote
              refusal={refusal}
              onChoosePharmacist={() =>
                document
                  .querySelector<HTMLButtonElement>("#rx-pharmacists button")
                  ?.focus()
              }
              onHold={onHold}
            />
          )}
          {prescription ? (
            <div className={d.linked}>
              <span className={d.rx}>Rx</span>
              <div>
                <b>
                  <span className={ui.mono}>{prescription.rxNumber}</span> ·{" "}
                  {prescription.patientName}
                </b>
                <small>
                  Dr {prescription.doctorName} · issued{" "}
                  {longDate(prescription.issuedOn)}
                  {prescription.validUntil
                    ? ` · valid until ${longDate(prescription.validUntil)}`
                    : ""}
                </small>
              </div>
              <button
                type="button"
                className={cx(ui.btn, ui.outline, ui.sm)}
                onClick={() => {
                  onPrescription(null);
                  setMode("find");
                }}
              >
                Change
              </button>
            </div>
          ) : mode === "record" ? (
            <RecordPrescription
              customer={customer}
              onCommandSent={onCommandSent}
              onRecorded={onPrescription}
              onFind={() => setMode("find")}
              onHold={onHold}
            />
          ) : (
            <FindPrescription
              customer={customer}
              onChange={onPrescription}
              onRecord={() => setMode("record")}
            />
          )}
          <div className={d.list}>
            <div className={d.subH}>
              Covers these items
              <span>
                {rxLines.length} of {rxLines.length}
              </span>
            </div>
            {rxLines.map((line) => (
              <div key={line.productId} className={d.cv}>
                <span className={cx(d.cb, d.cbOn)} aria-hidden="true">
                  <Icon name="check" />
                </span>
                <b>{line.name}</b>
                <span className={d.rx}>Rx</span>
                <span className={d.q}>
                  {line.qty}
                  {line.unit ? ` ${line.unit}` : ""}
                </span>
              </div>
            ))}
          </div>
          {hasControlled && (
            <Pharmacist
              approverId={approverId}
              pin={pin}
              onApprover={onApprover}
              onPin={onPin}
              pinRef={pinRef}
              refusedIds={refusedApproverIds}
            />
          )}
          {prescription && (
            <div className={d.autochecks}>
              {prescription.expired ? (
                <span className={d.warnCheck}>
                  <Icon name="x" />
                  Expired, so it can&apos;t be dispensed
                </span>
              ) : (
                <span>
                  <Icon name="check" />
                  {issuedAgo(prescription.issuedOn, today())}
                </span>
              )}
              {!prescription.expired && (
                <span>
                  <Icon name="check" />
                  {prescription.validUntil
                    ? `Valid until ${longDate(prescription.validUntil)}`
                    : "No end date"}
                </span>
              )}
              {hasControlled && (
                <span>
                  <Icon name="check" />
                  Counter online, so this can be co-signed
                </span>
              )}
            </div>
          )}
        </div>
        <div className={d.foot}>
          <div className={d.tot}>
            <small>Total</small>
            <b>Rs {totalText}</b>
          </div>
          <span className={ui.grow} />
          <button
            type="button"
            className={cx(ui.btn, ui.outline, ui.lg)}
            onClick={onClose}
          >
            Back to sale <KeyHint keys="Escape" small />
          </button>
          <button
            ref={continueRef}
            type="button"
            className={cx(ui.btn, ui.primary, ui.lg)}
            onClick={onContinue}
            disabled={!ready}
          >
            <Icon name="shield-check" />
            {hasControlled && approverId
              ? "Co-sign and pay"
              : "Continue to payment"}
            <KeyHint keys="Enter" small onPrimary />
          </button>
        </div>
      </aside>
    </>
  );
}
