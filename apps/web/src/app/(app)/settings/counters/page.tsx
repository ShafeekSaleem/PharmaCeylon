"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  CounterJournalSyncStatus,
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

type CounterEdit =
  | { kind: "rename"; counter: TerminalCounterView }
  | { kind: "stop"; counter: TerminalCounterView }
  | { kind: "delete"; counter: TerminalCounterView };

/** Why a counter cannot be stopped yet, in words for staff; null when it can. */
function stopBlocker(counter: TerminalCounterView): string | null {
  if (counter.terminal) return "A computer is still set up here. Retire it first.";
  if (counter.hasOpenShift) return "A shift is still open here. Close it first.";
  return null;
}
/** Why a counter cannot be deleted; null when it has never been used. */
const deleteBlocker = (counter: TerminalCounterView): string | null =>
  counter.hasHistory ? "Used before, so its records are kept. Stop using it instead." : null;

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
  const [journal, setJournal] = useState<CounterJournalSyncStatus | null>(null);
  const [journalFailed, setJournalFailed] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [edit, setEdit] = useState<CounterEdit | null>(null);

  const load = useCallback(async () => {
    // The sync status is extra: if it can't be read, the counters still can.
    const journalRead = countersApi.journalStatus().then(
      (status) => {
        setJournal(status);
        setJournalFailed(false);
      },
      () => setJournalFailed(true),
    );
    try {
      const [list, codeList] = await Promise.all([countersApi.counters(showInactive), countersApi.codes()]);
      setCounters(list);
      setCodes(codeList);
    } catch (err) {
      setError(message(err, "Couldn't load the counters."));
    }
    await journalRead;
  }, [showInactive]);
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

  async function reactivate(counter: TerminalCounterView) {
    setError(null);
    try {
      await countersApi.updateCounter(counter.registerId, { isActive: true });
      await load();
    } catch (err) {
      setError(message(err, "Couldn't start using the counter again."));
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
        <label className={css.rowHint}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{" "}
          Show counters no longer in use
        </label>
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
                      <CounterOfflineSales
                        counter={counter}
                        journal={journal?.enrollments ?? null}
                        timeZone={journal?.timezone ?? "Asia/Colombo"}
                        failed={journalFailed}
                      />
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
                        <ModalButton
                          variant="secondary"
                          onClick={() => setEdit({ kind: "rename", counter })}
                        >
                          Rename
                        </ModalButton>
                        {counter.isActive ? (
                          <ModalButton
                            variant="secondary"
                            disabled={stopBlocker(counter) !== null}
                            onClick={() => setEdit({ kind: "stop", counter })}
                          >
                            Stop using
                          </ModalButton>
                        ) : (
                          <ModalButton variant="secondary" onClick={() => void reactivate(counter)}>
                            Use again
                          </ModalButton>
                        )}
                        <ModalButton
                          variant="danger"
                          disabled={deleteBlocker(counter) !== null}
                          onClick={() => setEdit({ kind: "delete", counter })}
                        >
                          Delete
                        </ModalButton>
                      </div>
                      {counter.isActive && stopBlocker(counter) ? (
                        <div className={css.rowHint}>Stop using: {stopBlocker(counter)}</div>
                      ) : null}
                      {deleteBlocker(counter) ? (
                        <div className={css.rowHint}>Delete: {deleteBlocker(counter)}</div>
                      ) : null}
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
            Offline sales shows what each counter has sent the server, with times in the
            branch&apos;s timezone. &ldquo;Last received&rdquo; is the last upload that brought the
            server something new; a counter that has sold nothing offline since sends nothing new.
            A counter that is offline right now may still hold sales it hasn&apos;t sent, and when
            a journal stops at an entry, nothing after it reaches the server, so the server
            can&apos;t tell how many sales follow.
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
      <EditCounterModal
        edit={edit}
        onClose={() => setEdit(null)}
        onDone={() => {
          setEdit(null);
          void load();
        }}
      />
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

function EditCounterModal({
  edit,
  onClose,
  onDone,
}: {
  edit: CounterEdit | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLabel(edit?.counter.label ?? "");
    setError(null);
  }, [edit]);

  async function confirm() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      const id = edit.counter.registerId;
      if (edit.kind === "rename") await countersApi.updateCounter(id, { label: label.trim() });
      else if (edit.kind === "stop") await countersApi.updateCounter(id, { isActive: false });
      else await countersApi.deleteCounter(id);
      onDone();
    } catch (err) {
      setError(message(err, "That didn't go through."));
    } finally {
      setBusy(false);
    }
  }

  const name = edit?.counter.label ?? "this counter";
  const copy = {
    rename: {
      title: `Rename ${name}`,
      description: "Past sales and shifts show the new name too.",
      button: "Save name",
    },
    stop: {
      title: `Stop using ${name}?`,
      description:
        "It no longer shows when setting up a computer, and its records are kept. You can start using it again later.",
      button: "Stop using",
    },
    delete: {
      title: `Delete ${name}?`,
      description: "This counter has never been used. Deleting it cannot be undone.",
      button: "Delete counter",
    },
  }[edit?.kind ?? "rename"];

  return (
    <Modal
      open={edit !== null}
      onClose={onClose}
      canDismiss={!busy}
      size="sm"
      title={copy.title}
      description={copy.description}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </ModalButton>
          <ModalButton
            variant={edit?.kind === "delete" ? "danger" : "primary"}
            onClick={() => void confirm()}
            loading={busy}
            disabled={edit?.kind === "rename" && !label.trim()}
          >
            {copy.button}
          </ModalButton>
        </ModalFooter>
      }
    >
      {edit?.kind === "rename" ? (
        <FormField
          label="Counter name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={120}
        />
      ) : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Modal>
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
