"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CounterJournalSyncStatus,
  TerminalCounterView,
  TerminalEnrollmentCodeIssued,
  TerminalEnrollmentCodeView,
} from "@pharmaceylon/shared";
import { formatDisplayDateTime } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { IconPlus } from "@/components/icons";
import {
  ActionButton,
  FormField,
  Modal,
  ModalButton,
  ModalFooter,
  PageHeader,
  SelectField,
} from "@/components/ui";
import { fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../settings.module.css";
import cardCss from "./counters.module.css";
import { CounterCard, type CounterCardAction } from "./counter-card";
import { countersApi } from "./counters-api";
import { CounterDefaultsCard } from "./counter-defaults-card";
import { nearDuplicateOf } from "./counter-names";

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

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/**
 * W6 Counters: the registers at the chosen branch, the computer enrolled on each, and the
 * one-time codes that enroll a new one. Enrollment itself happens on the computer (P2); the web
 * issues codes and takes a lost or retired computer out of service. One card per counter
 * (UI1 #205).
 */
export default function CountersSettingsPage() {
  const { branchId } = useAuth();
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <PageHeader
        title="Counters"
        description="Each counter is one computer running PharmaCeylon POS."
        actions={
          <div className={cardCss.headerActions}>
            <BranchPicker />
            <ActionButton onClick={() => setAdding(true)} disabled={!branchId}>
              <IconPlus size={14} /> Add counter
            </ActionButton>
          </div>
        }
      />
      <div className={css.panel}>
        {branchId ? (
          <Counters key={branchId} adding={adding} onAddClose={() => setAdding(false)} />
        ) : null}
        <CounterDefaultsCard />
      </div>
    </div>
  );
}

/**
 * Counters belong to a branch, and every counters call is scoped by the selected branch, so
 * choosing one here is the same switch as the top bar's.
 */
function BranchPicker() {
  const { user, branchId, setBranchId } = useAuth();
  const [branches, setBranches] = useState<TenantBranch[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchTenantBranches().then(
      (list) => {
        if (!cancelled) setBranches(list);
      },
      () => {
        if (!cancelled) setBranches([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  // Only branches the person works at: anywhere else the API refuses every counters call.
  const mine = useMemo(() => {
    if (!branches || !user) return [];
    if (user.branchRoles.some((r) => r.role === "owner")) return branches;
    const ids = new Set(user.branchRoles.map((r) => r.branchId));
    return branches.filter((b) => ids.has(b.id));
  }, [branches, user]);
  if (mine.length < 2 || !branchId) return null;
  return (
    <SelectField
      className={cardCss.branchPicker}
      label="Branch"
      value={branchId}
      onChange={(id) => setBranchId(id)}
      options={mine.map((b) => ({ value: b.id, label: b.name }))}
      fullWidth={false}
    />
  );
}

function Counters({ adding, onAddClose }: { adding: boolean; onAddClose: () => void }) {
  const [counters, setCounters] = useState<TerminalCounterView[] | null>(null);
  const [codes, setCodes] = useState<TerminalEnrollmentCodeView[]>([]);
  const [error, setError] = useState<string | null>(null);
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
      const [list, codeList] = await Promise.all([
        countersApi.counters(showInactive),
        countersApi.codes(),
      ]);
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

  function act(counter: TerminalCounterView, action: CounterCardAction) {
    switch (action) {
      case "issue-code":
        return setIssueFor(counter);
      case "reactivate":
        return void reactivate(counter);
      case "rename":
      case "stop":
      case "delete":
        return setEdit({ kind: action, counter });
      case "report-lost":
        return setPending({ kind: "revoke", counter });
      case "retire":
        return setPending({ kind: "retire", counter });
    }
  }

  const outstanding = codes.filter((c) => c.status === "outstanding");
  const active = (counters ?? []).filter((c) => c.isActive);
  // Only counters still in use can be mixed up at the till.
  const similarTo = (counter: TerminalCounterView) =>
    counter.isActive
      ? (nearDuplicateOf(
          counter.label,
          active.filter((c) => c.registerId !== counter.registerId),
        )?.label ?? null)
      : null;

  return (
    <>
      <section className={cardCss.list} aria-label="Counters at this branch">
        {error ? <Alert variant="error">{error}</Alert> : null}
        {counters === null && !error ? <p className={css.rowHint}>Loading…</p> : null}
        {counters && counters.length === 0 ? (
          <p className={cardCss.empty}>No counters here yet. Add the first one with Add counter.</p>
        ) : null}
        {counters?.map((counter) => (
          <CounterCard
            key={counter.registerId}
            counter={counter}
            code={outstanding.find((c) => c.registerId === counter.registerId)}
            journal={journal}
            journalFailed={journalFailed}
            similarTo={similarTo(counter)}
            revokingCode={revoking !== null}
            onAction={(action) => act(counter, action)}
            onRevokeCode={(codeId) => void revokeCode(codeId)}
          />
        ))}
        <div className={cardCss.footer}>
          <label>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />{" "}
            Show counters no longer in use
          </label>
          <span>
            Related: <Link href="/settings/offline-selling">Offline selling</Link> ·{" "}
            <Link href="/settings/receipts">Receipts</Link> · Staff PINs are under each person in{" "}
            <Link href="/users">Users</Link>
          </span>
        </div>
      </section>

      <AddCounterModal
        open={adding}
        existing={active}
        onClose={onAddClose}
        onAdded={() => {
          onAddClose();
          void load();
        }}
      />
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
        others={active}
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

/** The near-duplicate warning while typing a counter's name. */
function SimilarNameNote({ name, others }: { name: string; others: TerminalCounterView[] }) {
  const close = nearDuplicateOf(name, others);
  if (!close) return null;
  return (
    <p className={cardCss.similar} role="note">
      The name is close to &ldquo;{close.label}&rdquo;. Choose one staff can tell apart.
    </p>
  );
}

function AddCounterModal({
  open,
  existing,
  onClose,
  onAdded,
}: {
  open: boolean;
  existing: TerminalCounterView[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setLabel("");
      setError(null);
    }
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await countersApi.createCounter(label.trim());
      onAdded();
    } catch (err) {
      setError(message(err, "Couldn't add the counter."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      canDismiss={!busy}
      size="sm"
      title="Add a counter"
      description="Name it after where it stands, so staff know which computer is which."
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </ModalButton>
          <ModalButton
            type="submit"
            form="add-counter-form"
            variant="primary"
            loading={busy}
            disabled={!label.trim()}
          >
            Add counter
          </ModalButton>
        </ModalFooter>
      }
    >
      <form id="add-counter-form" onSubmit={submit} aria-label="Add a counter">
        <FormField
          label="Counter name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Front counter"
          maxLength={120}
        />
      </form>
      <SimilarNameNote name={label} others={existing} />
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Modal>
  );
}

function EditCounterModal({
  edit,
  others,
  onClose,
  onDone,
}: {
  edit: CounterEdit | null;
  /** Counters in use, to warn when a new name is close to another's. */
  others: TerminalCounterView[];
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
      {edit?.kind === "rename" && label.trim() !== edit.counter.label.trim() ? (
        <SimilarNameNote
          name={label}
          others={others.filter((c) => c.registerId !== edit.counter.registerId)}
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
              fontFamily: "var(--pc-font-mono)",
              fontSize: "1.6rem",
              letterSpacing: "0.12em",
              textAlign: "center",
              margin: "0.5rem 0 1rem",
            }}
          >
            {issued.code}
          </p>
          <p className={css.rowHint}>
            For {issued.view.counterLabel}. Expires {formatDisplayDateTime(issued.view.expiresAt)}.
            This code is shown only now; write it down or issue a new one later.
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
      title={
        retire
          ? `Retire ${terminal?.label ?? "this computer"}?`
          : `Report ${terminal?.label ?? "this computer"} lost?`
      }
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
