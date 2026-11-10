"use client";

import { useEffect, useRef, useState } from "react";
import type {
  JournalRecoveryCutoff,
  OfflineCounterReplacementView,
  OfflineJournalRecoveriesView,
  OfflineJournalRecoveryStatus,
  OfflineJournalRecoveryView,
} from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import {
  FormField,
  Modal,
  ModalButton,
  ModalFooter,
  StatusBadge,
  type BadgeVariant,
} from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { useAuth } from "@/lib/use-auth";
import { journalRecoveryApi } from "./journal-recovery-api";
import css from "../settings.module.css";
import styles from "./assignment-delegations-card.module.css";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Couldn't load journal recovery. Try again.";
const when = (at: number) => new Date(at).toLocaleString();

const STATUS: Record<
  OfflineJournalRecoveryStatus,
  { label: string; variant: BadgeVariant }
> = {
  awaiting_approval: { label: "Waiting for approval", variant: "warning" },
  approved: { label: "Approved, finishing at the counter", variant: "info" },
  recovered: { label: "Recovered", variant: "success" },
  superseded: { label: "Replaced", variant: "default" },
};

function cutoffText(cutoff: JournalRecoveryCutoff): string {
  if (cutoff.kind === "never_issued")
    return "It was never given offline permission.";
  const outstanding =
    cutoff.lastGrantExpiresAt === null
      ? ""
      : ` Its last offline permission ${cutoff.lastGrantExpiresAt > Date.now() ? "expires" : "expired"} ${when(cutoff.lastGrantExpiresAt)}.`;
  return cutoff.kind === "device_disabled"
    ? `Switched off ${when(cutoff.at!)}.${outstanding}`
    : `Its offline permission ${cutoff.at! > Date.now() ? "expires" : "expired"} ${when(cutoff.at!)}.`;
}

/**
 * P5 #51, approved D11 (decisions of 2026-11-10): the branch's offline counter journal. The owner
 * or a delegated manager signs off the offline counter's journal so another counter can take over
 * (possible once its last offline permission has expired), and approves a restored counter's
 * journal recovery. The API enforces both; this card only explains.
 */
export function JournalRecoveryCard() {
  const { user, branchId } = useAuth();
  if (!branchId)
    return <p>Select a branch to review its offline counter journal.</p>;
  return (
    <JournalRecovery key={`${user?.id}:${branchId}`} branchId={branchId} />
  );
}

function JournalRecovery({ branchId }: { branchId: string }) {
  const [view, setView] = useState<OfflineJournalRecoveriesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [signingOff, setSigningOff] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    journalRecoveryApi(branchId)
      .list()
      .then(
        (next) => !cancelled && setView(next),
        (err) => !cancelled && setError(message(err)),
      );
    return () => {
      cancelled = true;
    };
  }, [branchId, reload]);

  const done = (text: string) => {
    setSigningOff(false);
    setReviewing(null);
    setNotice(text);
    setReload((n) => n + 1);
  };
  const open = view?.recoveries.filter(
    (r) =>
      r.kind === "counter_restore" &&
      (r.status === "awaiting_approval" || r.status === "approved"),
  );
  const history = view?.recoveries.filter((r) => !open?.includes(r));
  return (
    <section className={css.card} aria-label="Offline counter journal">
      <h2 className={css.cardTitle}>Offline counter journal</h2>
      <p className={css.cardDesc}>
        Offline sales reach the server as a journal. Before another counter can
        take over offline selling, the current one&apos;s journal is signed off;
        a counter restored from an older copy recovers its journal only once you
        approve it. Owners and managers they delegated can do both.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!view ? (
        error ? (
          <ModalButton onClick={() => setReload((n) => n + 1)}>
            Try again
          </ModalButton>
        ) : (
          <p role="status">Loading offline counter journal…</p>
        )
      ) : (
        <>
          {view.offlineCounter ? (
            <OfflineCounter
              counter={view.offlineCounter}
              onSignOff={() => setSigningOff(true)}
            />
          ) : (
            <p className={css.rowHint}>This branch has no offline counter.</p>
          )}
          <h3 className={css.rowLabel}>Restored counters</h3>
          <ul className={styles.list} aria-label="Journal recoveries">
            {open?.map((r) => (
              <li key={r.recoveryId} className={styles.row}>
                <div className={styles.person}>
                  <div className={css.rowLabel}>
                    {r.terminalLabel ?? "Counter"}
                  </div>
                  <div className={css.rowHint}>
                    Reported {when(r.createdAt)}.{" "}
                    {r.unmatched
                      ? `${r.unmatched} offline ${r.unmatched === 1 ? "record" : "records"} the server never received.`
                      : "Nothing was recorded on it that the server lacks."}
                    {r.stale
                      ? " The server's journal changed since; the counter reports again by itself."
                      : ""}
                  </div>
                </div>
                <div className={styles.actions}>
                  <StatusBadge
                    status={r.status}
                    label={STATUS[r.status].label}
                    variant={STATUS[r.status].variant}
                  />
                  {r.status === "awaiting_approval" && !r.stale ? (
                    <ModalButton onClick={() => setReviewing(r.recoveryId)}>
                      Review
                      <span className="pc-sr-only">
                        {" "}
                        {r.terminalLabel ?? "counter"}
                      </span>
                    </ModalButton>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {!open?.length ? (
            <p className={css.rowHint}>
              No counter is waiting to recover its journal.
            </p>
          ) : null}
          {history?.length ? (
            <details>
              <summary className={css.rowHint}>
                Earlier recoveries and sign-offs
              </summary>
              <ul
                className={styles.list}
                aria-label="Earlier journal recoveries"
              >
                {history.map((r) => (
                  <li key={r.recoveryId} className={styles.row}>
                    <div className={styles.person}>
                      <div className={css.rowLabel}>
                        {r.kind === "missing_journal"
                          ? "Journal sign-off"
                          : "Restored counter"}
                        : {r.terminalLabel ?? "Counter"}
                      </div>
                      <div className={css.rowHint}>{when(r.createdAt)}</div>
                    </div>
                    <StatusBadge
                      status={r.status}
                      label={
                        r.kind === "missing_journal" && r.status === "approved"
                          ? "Signed off"
                          : STATUS[r.status].label
                      }
                      variant={STATUS[r.status].variant}
                    />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      {signingOff && view?.offlineCounter ? (
        <SignOffDialog
          branchId={branchId}
          counter={view.offlineCounter}
          onClose={() => setSigningOff(false)}
          onDone={() =>
            done(
              "Journal signed off. Another counter can now take over offline selling.",
            )
          }
        />
      ) : null}
      {reviewing ? (
        <ReviewDialog
          branchId={branchId}
          recoveryId={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() =>
            done(
              "Recovery approved. The counter finishes it the next time it is online.",
            )
          }
        />
      ) : null}
    </section>
  );
}

function OfflineCounter({
  counter,
  onSignOff,
}: {
  counter: OfflineCounterReplacementView;
  onSignOff: () => void;
}) {
  const availableAt = counter.signOffAvailableAt;
  const tooEarly = availableAt !== null && availableAt > Date.now();
  const entries = counter.serverHead.sequence;
  return (
    <div className={styles.row} aria-label="Offline counter">
      <div className={styles.person}>
        <div className={css.rowLabel}>
          {counter.terminalLabel ?? "Offline counter"}
        </div>
        <div className={css.rowHint}>
          {entries
            ? `The server has ${entries} offline ${entries === 1 ? "record" : "records"} from it${
                counter.serverHead.acceptedAt
                  ? `, the last received ${when(counter.serverHead.acceptedAt)}`
                  : ""
              }.`
            : "The server has no offline records from it."}{" "}
          {cutoffText(counter.cutoff)}
        </div>
        {counter.refusals.length ? (
          <div className={css.rowHint}>
            {counter.refusals.length} refused{" "}
            {counter.refusals.length === 1 ? "record is" : "records are"} kept
            for review; {counter.refusals.length === 1 ? "it is" : "they are"}{" "}
            not part of the journal.
          </div>
        ) : null}
        <div className={css.rowHint}>
          {counter.journalCleared && counter.signOff
            ? `Journal signed off by ${counter.signOff.approvedByFullName ?? "a manager"} ${when(counter.signOff.approvedAt)}. Another counter can take over.`
            : counter.signOff
              ? "The last sign-off no longer covers this journal: more records arrived, or the counter was given offline permission again. Sign off again to replace it."
              : tooEarly
                ? `It could still be selling offline. Its journal can be signed off from ${when(availableAt!)}.`
                : "Sign off its journal before another counter takes over offline selling."}
        </div>
      </div>
      <div className={styles.actions}>
        {counter.journalCleared ? (
          <StatusBadge status="cleared" label="Signed off" variant="success" />
        ) : (
          <ModalButton onClick={onSignOff} disabled={tooEarly}>
            Sign off journal
          </ModalButton>
        )}
      </div>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  async function submit(action: () => Promise<unknown>, onDone: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (mounted.current) onDone();
    } catch (err) {
      if (mounted.current) setError(message(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { busy, error, submit };
}

function SignOffDialog({
  branchId,
  counter,
  onClose,
  onDone,
}: {
  branchId: string;
  counter: OfflineCounterReplacementView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, submit } = useSubmit();
  const entries = counter.serverHead.sequence;
  return (
    <Modal
      open
      title="Sign off the offline counter's journal"
      size="sm"
      canDismiss={!busy}
      onClose={onClose}
      footer={
        <ModalFooter>
          <ModalButton disabled={busy} onClick={onClose}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="primary"
            disabled={busy || !reason.trim()}
            loading={busy}
            onClick={() =>
              void submit(
                () =>
                  journalRecoveryApi(branchId).signOff({
                    enrollmentId: counter.enrollmentId,
                    expectedNominationVersion: counter.nominationVersion,
                    expectedServerHeadSequence: entries,
                    reason: reason.trim(),
                  }),
                onDone,
              )
            }
          >
            Sign off journal
          </ModalButton>
        </ModalFooter>
      }
    >
      <p>
        You confirm that the server&apos;s {entries} offline{" "}
        {entries === 1 ? "record" : "records"} from{" "}
        {counter.terminalLabel ?? "this counter"} are everything it sold
        offline, or that you have accounted for any sale it never uploaded
        (stock counted, cash reconciled). Anything it uploads later stays
        visible for review.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <FormField
        as="textarea"
        label="What you checked"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        required
        disabled={busy}
      />
    </Modal>
  );
}

function ReviewDialog({
  branchId,
  recoveryId,
  onClose,
  onDone,
}: {
  branchId: string;
  recoveryId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [detail, setDetail] = useState<OfflineJournalRecoveryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const { busy, error, submit } = useSubmit();
  useEffect(() => {
    let cancelled = false;
    journalRecoveryApi(branchId)
      .detail(recoveryId)
      .then(
        (next) => !cancelled && setDetail(next),
        (err) => !cancelled && setLoadError(message(err)),
      );
    return () => {
      cancelled = true;
    };
  }, [branchId, recoveryId]);
  const unmatched = detail?.unmatched ?? [];
  const approvable = detail?.status === "awaiting_approval" && !detail.stale;
  return (
    <Modal
      open
      title="Restored counter: approve journal recovery"
      size="lg"
      canDismiss={!busy}
      onClose={onClose}
      footer={
        <ModalFooter>
          <ModalButton disabled={busy} onClick={onClose}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="primary"
            disabled={busy || !approvable || !reason.trim()}
            loading={busy}
            onClick={() =>
              detail &&
              void submit(
                () =>
                  journalRecoveryApi(branchId).approve(recoveryId, {
                    reason: reason.trim(),
                    expectedServerHeadSequence: detail.serverHead.sequence,
                    expectedUnmatched: unmatched.length,
                  }),
                onDone,
              )
            }
          >
            Approve recovery
          </ModalButton>
        </ModalFooter>
      }
    >
      {loadError ? <Alert variant="error">{loadError}</Alert> : null}
      {!detail ? (
        loadError ? null : (
          <p role="status">Loading recovery…</p>
        )
      ) : (
        <>
          <p>
            {detail.terminalLabel ?? "This counter"} was restored from an older
            copy. The server has {detail.serverHead.sequence} offline records
            from it; this computer shares the first{" "}
            {detail.commonPrefix?.sequence ?? 0} and gets back the{" "}
            {detail.restoredEntries} it lost. Its offline permission is removed
            until it is issued a new one.
          </p>
          {unmatched.length ? (
            <>
              <p>
                These were recorded on the restored computer and never reached
                the server. They are kept as evidence and are{" "}
                <strong>not</strong> posted as sales. Settle their stock and
                cash (for example a stock adjustment and a cash count), then say
                how below.
              </p>
              <table
                className={css.table}
                aria-label="Records the server never received"
              >
                <thead>
                  <tr>
                    <th>#</th>
                    <th>When</th>
                    <th>Staff</th>
                    <th>Record</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatched.map((u) => (
                    <tr key={u.commandId}>
                      <td>{u.sequence}</td>
                      <td>{when(u.occurredAt)}</td>
                      <td>{u.staffFullName ?? "Unknown"}</td>
                      <td>
                        {u.kind === "ordinary_sale"
                          ? `Sale, ${u.lineCount} ${u.lineCount === 1 ? "line" : "lines"}`
                          : u.kind === "shift_open"
                            ? "Shift opened"
                            : "Shift closed"}
                      </td>
                      <td>
                        {u.totalMinor === null
                          ? ""
                          : formatMoney(u.totalMinor / 100)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p>
              Nothing was recorded on the restored computer that the server
              lacks.
            </p>
          )}
          {detail.stale ? (
            <Alert variant="warning">
              The server&apos;s journal changed since this was reported. The
              counter reports again by itself; review that one instead.
            </Alert>
          ) : null}
          {error ? <Alert variant="error">{error}</Alert> : null}
          <FormField
            as="textarea"
            label={
              unmatched.length
                ? "How the stock and cash were settled"
                : "Reason"
            }
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            required
            disabled={busy || !approvable}
          />
        </>
      )}
    </Modal>
  );
}
