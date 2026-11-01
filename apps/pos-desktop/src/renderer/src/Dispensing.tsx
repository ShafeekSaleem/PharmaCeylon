import { useEffect, useState, type FormEvent } from "react";
import type {
  ApproverView,
  CustomerView,
  PrescriptionView,
} from "../../shared/ipc-contract";
import styles from "./App.module.css";
import { invoke } from "./invoke";

/** Today on this computer's calendar: a prescription written this morning in Colombo is dated
 * today, though UTC may still be yesterday. */
const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

function CustomerPicker({
  customer,
  onChange,
}: {
  customer: CustomerView | null;
  onChange: (customer: CustomerView | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<CustomerView[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function search(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!query.trim()) return;
    const result = await invoke(() => window.pos.searchCustomers({ q: query }));
    if (result.ok) setFound(result.value);
    else setError(result.error.message);
  }

  if (customer)
    return (
      <p>
        Customer: <strong>{customer.fullName}</strong>
        {customer.phone ? ` · ${customer.phone}` : ""}{" "}
        <button
          type="button"
          className="pc-btn-outline"
          onClick={() => onChange(null)}
        >
          Remove
        </button>
      </p>
    );
  return (
    <form className={styles.form} onSubmit={search}>
      <label className={styles.field}>
        <span>Customer (optional)</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or phone"
        />
      </label>
      {found.length > 0 && (
        <ul className={styles.counterList}>
          {found.map((c) => (
            <li key={c.customerId}>
              <button
                type="button"
                className={styles.counterOption}
                onClick={() => {
                  onChange(c);
                  setFound([]);
                  setQuery("");
                }}
              >
                <span>{c.fullName}</span>
                <span className="pc-muted">{c.phone ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className={styles.resultFailed}>{error}</p>}
    </form>
  );
}

function RecordPrescription({
  customer,
  onRecorded,
  onCancel,
}: {
  customer: CustomerView | null;
  onRecorded: (prescription: PrescriptionView) => void;
  onCancel: () => void;
}) {
  const [patientName, setPatientName] = useState(customer?.fullName ?? "");
  const [doctorName, setDoctorName] = useState("");
  const [doctorRegNo, setDoctorRegNo] = useState("");
  const [issuedOn, setIssuedOn] = useState(today());
  const [validUntil, setValidUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(() =>
        window.pos.recordPrescription({
          patientName,
          doctorName,
          issuedOn,
          ...(doctorRegNo.trim() ? { doctorRegNo } : {}),
          ...(validUntil ? { validUntil } : {}),
          ...(customer ? { customerId: customer.customerId } : {}),
        }),
      );
      if (result.ok) onRecorded(result.value);
      else setError(result.error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={save} aria-label="Record prescription">
      <label className={styles.field}>
        <span>Patient name</span>
        <input
          value={patientName}
          onChange={(e) => setPatientName(e.target.value)}
          required
          minLength={2}
        />
      </label>
      <label className={styles.field}>
        <span>Doctor</span>
        <input
          value={doctorName}
          onChange={(e) => setDoctorName(e.target.value)}
          required
          minLength={2}
        />
      </label>
      <label className={styles.field}>
        <span>Doctor's registration number (optional)</span>
        <input
          value={doctorRegNo}
          onChange={(e) => setDoctorRegNo(e.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <label className={styles.field}>
          <span>Issued on</span>
          <input
            type="date"
            value={issuedOn}
            max={today()}
            onChange={(e) => setIssuedOn(e.target.value)}
            required
          />
        </label>
        <label className={styles.field}>
          <span>Valid until (optional)</span>
          <input
            type="date"
            value={validUntil}
            min={issuedOn}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </label>
      </div>
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-primary-sm" disabled={busy}>
          {busy ? "Saving…" : "Save prescription"}
        </button>
        <button type="button" className="pc-btn-outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className={styles.resultFailed}>{error}</p>}
    </form>
  );
}

function PrescriptionPicker({
  customer,
  prescription,
  onChange,
}: {
  customer: CustomerView | null;
  prescription: PrescriptionView | null;
  onChange: (prescription: PrescriptionView | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PrescriptionView[]>([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A chosen customer's own prescriptions are the likely ones; show them without a search.
  useEffect(() => {
    if (!customer || prescription) return;
    void invoke(() =>
      window.pos.searchPrescriptions({ customerId: customer.customerId }),
    ).then((result) => setFound(result.ok ? result.value : []));
  }, [customer, prescription]);

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

  if (prescription)
    return (
      <p>
        Prescription: <strong>{prescription.rxNumber}</strong> ·{" "}
        {prescription.patientName} · Dr {prescription.doctorName}
        {prescription.expired && (
          <span className={styles.resultFailed}> · expired, cannot dispense</span>
        )}{" "}
        <button
          type="button"
          className="pc-btn-outline"
          onClick={() => onChange(null)}
        >
          Unlink
        </button>
      </p>
    );
  if (recording)
    return (
      <RecordPrescription
        customer={customer}
        onRecorded={(rx) => {
          setRecording(false);
          onChange(rx);
        }}
        onCancel={() => setRecording(false)}
      />
    );
  return (
    <form className={styles.form} onSubmit={search}>
      <label className={styles.field}>
        <span>Prescription</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rx number, patient or doctor"
        />
      </label>
      <div className={styles.actions}>
        <button type="submit" className="pc-btn-outline">
          Find
        </button>
        <button
          type="button"
          className="pc-btn-outline"
          onClick={() => setRecording(true)}
        >
          Record a new prescription
        </button>
      </div>
      {found.length > 0 && (
        <ul className={styles.counterList}>
          {found.map((rx) => (
            <li key={rx.prescriptionId}>
              <button
                type="button"
                className={styles.counterOption}
                onClick={() => onChange(rx)}
                disabled={rx.expired}
              >
                <span>
                  {rx.rxNumber} · {rx.patientName}
                </span>
                <span className="pc-muted">
                  Dr {rx.doctorName} · {rx.issuedOn}
                  {rx.expired ? " · expired" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className={styles.resultFailed}>{error}</p>}
    </form>
  );
}

/** Who signs off controlled items. Blank means the person signed in dispenses them; the server decides. */
export function CoSignFields({
  approverId,
  pin,
  onApprover,
  onPin,
  fixedApproverId,
}: {
  approverId: string;
  pin: string;
  onApprover: (id: string) => void;
  onPin: (pin: string) => void;
  fixedApproverId?: string;
}) {
  const [approvers, setApprovers] = useState<ApproverView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void invoke(() => window.pos.listApprovers()).then((result) => {
      if (result.ok) setApprovers(result.value);
      else setError(result.error.message);
    });
  }, []);
  const chosen = approvers.find((a) => a.userId === approverId);
  return (
    <div className={styles.actions}>
      <label className={styles.field}>
        <span>Pharmacist co-sign</span>
        <select
          value={approverId}
          onChange={(e) => onApprover(e.target.value)}
          disabled={Boolean(fixedApproverId)}
        >
          {!fixedApproverId && (
            <option value="">I am dispensing these myself</option>
          )}
          {approvers.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.fullName}
            </option>
          ))}
        </select>
      </label>
      {approverId && (
        <label className={styles.field}>
          <span>{chosen && !chosen.hasPin ? "Their login password" : "Their PIN"}</span>
          <input
            type="password"
            autoComplete="off"
            value={pin}
            onChange={(e) => onPin(e.target.value)}
          />
        </label>
      )}
      {error && <p className={styles.resultFailed}>{error}</p>}
    </div>
  );
}

/**
 * Prescription and controlled-medicine details for the sale. Shown when the cart has items that
 * need them; the server re-checks the prescription, its expiry and the co-signer's authority.
 */
export function DispensingPanel({
  needsPrescription,
  hasControlled,
  customer,
  prescription,
  approverId,
  pin,
  onCustomer,
  onPrescription,
  onApprover,
  onPin,
}: {
  needsPrescription: boolean;
  hasControlled: boolean;
  customer: CustomerView | null;
  prescription: PrescriptionView | null;
  approverId: string;
  pin: string;
  onCustomer: (customer: CustomerView | null) => void;
  onPrescription: (prescription: PrescriptionView | null) => void;
  onApprover: (id: string) => void;
  onPin: (pin: string) => void;
}) {
  return (
    <div className={styles.form} aria-label="Dispensing">
      <h3 className={styles.panelTitle}>
        {needsPrescription ? "Prescription items" : "Customer"}
      </h3>
      <CustomerPicker customer={customer} onChange={onCustomer} />
      {needsPrescription && (
        <PrescriptionPicker
          customer={customer}
          prescription={prescription}
          onChange={onPrescription}
        />
      )}
      {hasControlled && (
        <CoSignFields
          approverId={approverId}
          pin={pin}
          onApprover={onApprover}
          onPin={onPin}
        />
      )}
    </div>
  );
}
