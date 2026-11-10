"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  CounterJournalSyncView,
  TerminalCounterView,
  TerminalEnrollmentCodeIssued,
  TerminalEnrollmentCodeView,
} from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { FormField, Modal, ModalButton, ModalFooter, PageHeader, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import css from "../settings.module.css";
import { countersApi } from "./counters-api";
import { CounterOfflineSales } from "./offline-sync";

const CODE_LIFETIMES = [
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "24 hours" },
];

type PendingAction =
  | { kind: "revoke"; counter: TerminalCounterView }
  | { kind: "retire"; counter: TerminalCounterView };

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

function counterStatus(counter: TerminalCounterView): {
  status: string;
  label: string;
  variant: "success" | "warning" | "default";
} {
  if (!counter.isActive) return { status: "inactive", label: "Inactive", variant: "default" };
  if (!counter.terminal) return { status: "empty", label: "No computer", variant: "default" };
  if (!counter.terminal.enrollmentId)
    return { status: "revoked", label: "Key revoked", variant: "warning" };
  return { status: "enrolled", label: "Enrolled", variant: "success" };
}

/**
 * W6 Counters: the registers at the selected branch, the computer enrolled on each, and the
 * one-time codes that enroll a new one. Enrollment itself happens on the computer (P2); the web
 * issues codes and takes a lost or retired computer out of service.
 */
export default function CountersSettingsPage() {
  const { branchId } = useAuth();
  return (
    <div>
      <PageHeader
        title="Counters"
        description="The checkout counters at this branch, the computer enrolled on each, and codes for enrolling a new one."
      />
      <div className={css.panel}>{branchId ? <Counters key={branchId} /> : null}</div>
    </div>
  );
}

function Counters() {
  const [counters, setCounters] = useState<TerminalCounterView[] | null>(null);
  const [codes, setCodes] = useState<TerminalEnrollmentCodeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [issueFor, setIssueFor] = useState<TerminalCounterView | null>(null);
  const [issued, setIssued] = useState<TerminalEnrollmentCodeIssued | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [journal, setJournal] = useState<CounterJournalSyncView[] | null>(null);
  const [journalFailed, setJournalFailed] = useState(false);

  const load = useCallback(async () => {
    // The sync status is extra: if it can't be read, the counters still can.
    const journalRead = countersApi.journalStatus().then(
      (views) => {
        setJournal(views);
        setJournalFailed(false);
      },
      () => setJournalFailed(true),
    );
    try {
      const [list, codeList] = await Promise.all([countersApi.counters(), countersApi.codes()]);
      setCounters(list);
      setCodes(codeList);
    } catch (err) {
      setError(message(err, "Couldn't load the counters."));
    }
    await journalRead;
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function addCounter(event: FormEvent) {
    event.preventDefault();
    if (!newLabel.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await countersApi.createCounter(newLabel.trim());
      setNewLabel("");
      await load();
    } catch (err) {
      setError(message(err, "Couldn't add the counter."));
    } finally {
      setAdding(false);
    }
  }

  async function revokeCode(codeId: string) {
    if (revoking) return;
    setRevoking(codeId);
    setError(null);
    try {
      await countersApi.revokeCode(codeId);
      await load();
    } catch (err) {
      setError(message(err, "Couldn't revoke the code."));
    } finally {
      setRevoking(null);
    }
  }

  const outstanding = codes.filter((c) => c.status === "outstanding");
  const outstandingFor = (registerId: string) => outstanding.find((c) => c.registerId === registerId);

  return (
    <>
      <section className={css.card} aria-label="Counters at this branch">
        <h2 className={css.cardTitle}>Counters</h2>
        <p className={css.cardDesc}>
          Each counter takes one computer running PharmaCeylon POS. To enroll one, issue a code
          here and enter it on the computer, or sign in there as a manager and choose the counter.
        </p>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {counters === null && !error ? <p className={css.rowHint}>Loading…</p> : null}
        {counters && counters.length === 0 ? (
          <p className={css.rowHint}>No counters yet. Add the first one below.</p>
        ) : null}
        {counters && counters.length > 0 ? (
          <table className={css.table}>
            <thead>
              <tr>
                <th>Counter</th>
                <th>Computer</th>
                <th>Status</th>
                <th>Offline sales</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {counters.map((counter) => {
                const status = counterStatus(counter);
                const code = outstandingFor(counter.registerId);
                return (
                  <tr key={counter.registerId}>
                    <td>{counter.label}</td>
                    <td>
                      {counter.terminal ? (
                        <>
                          {counter.terminal.label}
                          {counter.terminal.enrolledAt ? (
                            <div className={css.rowHint}>
                              Enrolled {new Date(counter.terminal.enrolledAt).toLocaleDateString()}
                            </div>
                          ) : null}
                        </>
                      ) : code ? (
                        <span className={css.rowHint}>
                          Code waiting, expires {new Date(code.expiresAt).toLocaleTimeString()}
                        </span>
                      ) : (
                        <span className={css.rowHint}>—</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={status.status} label={status.label} variant={status.variant} />
                    </td>
                    <td>
                      <CounterOfflineSales counter={counter} journal={journal} failed={journalFailed} />
                    </td>
                    <td>
                      <div className={css.chipRow}>
                        {!counter.terminal && counter.isActive ? (
                          <ModalButton variant="secondary" onClick={() => setIssueFor(counter)}>
                            Enrollment code
                          </ModalButton>
                        ) : null}
                        {counter.terminal?.enrollmentId ? (
                          <ModalButton
                            variant="secondary"
                            onClick={() => setPending({ kind: "revoke", counter })}
                          >
                            Report lost
                          </ModalButton>
                        ) : null}
                        {counter.terminal ? (
                          <ModalButton
                            variant="danger"
                            onClick={() => setPending({ kind: "retire", counter })}
                          >
                            Retire computer
                          </ModalButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        <form className={css.saveRow} onSubmit={addCounter} aria-label="Add a counter">
          <FormField
            label="New counter"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. Front counter"
            maxLength={120}
          />
          <ModalButton type="submit" variant="primary" loading={adding} disabled={!newLabel.trim()}>
            Add counter
          </ModalButton>
        </form>
        {counters && counters.length > 0 ? (
          <p className={css.rowHint}>
            Offline sales shows what each counter has sent the server. A counter that is offline
            right now may still hold sales it hasn&apos;t sent.
          </p>
        ) : null}
        <p className={css.rowHint}>
          Offline selling is set in <Link href="/settings/offline-policy">Offline policy</Link>.
          Staff PINs and which counters each person has prepared are under each person in{" "}
          <Link href="/users">Users</Link>.
        </p>
      </section>

      {outstanding.length > 0 ? (
        <section className={css.card} aria-label="Waiting enrollment codes">
          <h2 className={css.cardTitle}>Waiting enrollment codes</h2>
          <p className={css.cardDesc}>
            A code enrolls one computer, once, before it expires. Revoke any you no longer need.
          </p>
          {outstanding.map((code) => (
            <div key={code.codeId} className={css.rowItem}>
              <span>{code.counterLabel}</span>
              <span className={css.rowHint}>
                Expires {new Date(code.expiresAt).toLocaleString()}
              </span>
              <ModalButton
                variant="secondary"
                onClick={() => void revokeCode(code.codeId)}
                loading={revoking === code.codeId}
                disabled={revoking !== null}
              >
                Revoke
              </ModalButton>
            </div>
          ))}
        </section>
      ) : null}

      <IssueCodeModal
        counter={issueFor}
        onClose={() => setIssueFor(null)}
        onIssued={(result) => {
          setIssueFor(null);
          setIssued(result);
          void load();
        }}
      />
      <IssuedCodeModal issued={issued} onClose={() => setIssued(null)} />
      <ReasonModal
        action={pending}
        onClose={() => setPending(null)}
        onDone={() => {
          setPending(null);
          void load();
        }}
      />
    </>
  );
}

function IssueCodeModal({
  counter,
  onClose,
  onIssued,
}: {
  counter: TerminalCounterView | null;
  onClose: () => void;
  onIssued: (issued: TerminalEnrollmentCodeIssued) => void;
}) {
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function issue() {
    if (!counter) return;
    setBusy(true);
    setError(null);
    try {
      onIssued(await countersApi.issueCode(counter.registerId, minutes));
    } catch (err) {
      setError(message(err, "Couldn't issue a code."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={counter !== null}
      onClose={onClose}
      title={`Enrollment code for ${counter?.label ?? ""}`}
      description="Whoever enters this code on the computer enrolls it to this counter with their own account."
      canDismiss={!busy}
      size="sm"
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void issue()} loading={busy}>
            Issue code
          </ModalButton>
        </ModalFooter>
      }
    >
      <FormField
        as="select"
        label="Valid for"
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value))}
      >
        {CODE_LIFETIMES.map((option) => (
          <option key={option.minutes} value={option.minutes}>
            {option.label}
          </option>
        ))}
      </FormField>
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Modal>
  );
}

/** The code is shown once: only its hash is kept, so it can't be shown again after closing. */
function IssuedCodeModal({
  issued,
  onClose,
}: {
  issued: TerminalEnrollmentCodeIssued | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={issued !== null}
      onClose={onClose}
      title="Enter this code on the computer"
      size="sm"
      closeOnBackdrop={false}
      footer={
        <ModalFooter>
          <ModalButton variant="primary" onClick={onClose}>
            Done
          </ModalButton>
        </ModalFooter>
      }
    >
      {issued ? (
        <>
          <p
            aria-label="Enrollment code"
            style={{
              fontFamily: "var(--pc-font-mono, monospace)",
              fontSize: "1.6rem",
              letterSpacing: "0.12em",
              textAlign: "center",
              margin: "0.5rem 0 1rem",
            }}
          >
            {issued.code}
          </p>
          <p className={css.rowHint}>
            For {issued.view.counterLabel}. Expires{" "}
            {new Date(issued.view.expiresAt).toLocaleString()}. This code is shown only now;
            write it down or issue a new one later.
          </p>
        </>
      ) : null}
    </Modal>
  );
}

function ReasonModal({
  action,
  onClose,
  onDone,
}: {
  action: PendingAction | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason("");
    setError(null);
  }, [action]);

  const terminal = action?.counter.terminal;
  const retire = action?.kind === "retire";

  async function confirm() {
    if (!action || !terminal || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (retire) await countersApi.retireDevice(terminal.terminalId, reason.trim());
      else await countersApi.revokeEnrollment(terminal.enrollmentId!, reason.trim());
      onDone();
    } catch (err) {
      setError(message(err, "That didn't go through."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={action !== null}
      onClose={onClose}
      canDismiss={!busy}
      size="sm"
      title={retire ? `Retire ${terminal?.label ?? "this computer"}?` : `Report ${terminal?.label ?? "this computer"} lost?`}
      description={
        retire
          ? "The computer leaves service for good and the counter is free for another one. Its sales history stays."
          : "Its key stops working straight away, so it can't sell or sign anything. Enroll it again if it turns up."
      }
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="danger"
            onClick={() => void confirm()}
            loading={busy}
            disabled={!reason.trim()}
          >
            {retire ? "Retire computer" : "Revoke key"}
          </ModalButton>
        </ModalFooter>
      }
    >
      <FormField
        as="textarea"
        label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        rows={3}
        placeholder={retire ? "e.g. Replaced with a new PC" : "e.g. Stolen from the shop overnight"}
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Modal>
  );
}
