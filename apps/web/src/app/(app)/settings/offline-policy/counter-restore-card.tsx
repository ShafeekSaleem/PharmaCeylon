"use client";

import { useEffect, useRef, useState } from "react";
import type {
  OfflineCounterRestoresView,
  OfflineCounterRestoreView,
} from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import {
  FormField,
  Modal,
  ModalButton,
  ModalFooter,
  StatusBadge,
} from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { counterRestoreApi } from "./counter-restore-api";
import css from "../settings.module.css";
import styles from "./assignment-delegations-card.module.css";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Couldn't load restored counters. Try again.";
const when = (at: number) => new Date(at).toLocaleString();

/** Since when anything the counter recorded may be missing: the later of the backup and last contact. */
export function lostSince(restore: OfflineCounterRestoreView): number {
  return Math.max(restore.backupTakenAt, restore.lastContactAt ?? 0);
}

function whatMayBeMissing(r: OfflineCounterRestoreView): string {
  const records = r.serverHead.sequence;
  const parts = [
    `Restored ${when(r.restoredAt)} from a backup taken ${when(r.backupTakenAt)}.`,
    `Anything it recorded after ${when(lostSince(r))} and never uploaded is gone from it.`,
  ];
  if (r.outageActive)
    parts.push(
      "The backup was taken during an internet outage, so offline sales after it may be missing, and the counter cannot sell until you acknowledge.",
    );
  parts.push(
    records > r.journalHead.sequence
      ? `The server has ${records} offline records from it; the backup had ${r.journalHead.sequence}. The counter gets the rest back from the server.`
      : `The server has ${records} offline ${records === 1 ? "record" : "records"} from it.`,
  );
  return parts.join(" ");
}

/**
 * P5 #51, store backup and restore (decisions of 2026-11-10): counters at this branch that
 * restored their store from a backup. A restore can hide offline sales made after the backup, so
 * the counter gets no offline permission until the owner or a delegated manager acknowledges it,
 * saying how receipts, cash and stock since the backup were checked. Online selling carries on,
 * unless the backup was taken mid-outage (its drain waits for a fresh pair). The API enforces who
 * may acknowledge; this card only explains.
 */
export function CounterRestoreCard() {
  const { user, branchId } = useAuth();
  if (!branchId) return <p>Select a branch to review its restored counters.</p>;
  return (
    <CounterRestores key={`${user?.id}:${branchId}`} branchId={branchId} />
  );
}

function CounterRestores({ branchId }: { branchId: string }) {
  const [view, setView] = useState<OfflineCounterRestoresView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [acknowledging, setAcknowledging] =
    useState<OfflineCounterRestoreView | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    counterRestoreApi(branchId)
      .list()
      .then(
        (next) => !cancelled && setView(next),
        (err) => !cancelled && setError(message(err)),
      );
    return () => {
      cancelled = true;
    };
  }, [branchId, reload]);

  const awaiting = view?.restores.filter(
    (r) => r.status === "awaiting_acknowledgement",
  );
  const history = view?.restores.filter(
    (r) => r.status !== "awaiting_acknowledgement",
  );
  return (
    <section className={css.card} aria-label="Restored counters">
      <h2 className={css.cardTitle}>Restored counters</h2>
      <p className={css.cardDesc}>
        A counter whose store was damaged can be restored from one of its own
        backups. Anything it recorded after the backup and never uploaded is
        gone from it, so it sells offline again only once you have checked
        receipts, cash and stock since the backup. Online selling carries on,
        unless the backup was taken during an internet outage: then the counter
        waits for you before it sells at all. Owners and managers they delegated
        can acknowledge a restore.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!view ? (
        error ? (
          <ModalButton onClick={() => setReload((n) => n + 1)}>
            Try again
          </ModalButton>
        ) : (
          <p role="status">Loading restored counters…</p>
        )
      ) : (
        <>
          <ul className={styles.list} aria-label="Restores waiting for you">
            {awaiting?.map((r) => (
              <li key={r.id} className={styles.row}>
                <div className={styles.person}>
                  <div className={css.rowLabel}>
                    {r.terminalLabel ?? "Counter"}
                  </div>
                  <div className={css.rowHint}>{whatMayBeMissing(r)}</div>
                </div>
                <div className={styles.actions}>
                  <StatusBadge
                    status={r.status}
                    label="Waiting for you"
                    variant="warning"
                  />
                  <ModalButton onClick={() => setAcknowledging(r)}>
                    Acknowledge
                    <span className="pc-sr-only">
                      {" "}
                      {r.terminalLabel ?? "counter"}
                    </span>
                  </ModalButton>
                </div>
              </li>
            ))}
          </ul>
          {!awaiting?.length ? (
            <p className={css.rowHint}>
              No restored counter is waiting for you.
            </p>
          ) : null}
          {history?.length ? (
            <details>
              <summary className={css.rowHint}>Earlier restores</summary>
              <ul className={styles.list} aria-label="Earlier restores">
                {history.map((r) => (
                  <li key={r.id} className={styles.row}>
                    <div className={styles.person}>
                      <div className={css.rowLabel}>
                        {r.terminalLabel ?? "Counter"}
                      </div>
                      <div className={css.rowHint}>
                        Restored {when(r.restoredAt)}
                        {r.acknowledgement
                          ? `; acknowledged ${when(r.acknowledgement.acknowledgedAt)} by ${r.acknowledgement.acknowledgedByFullName ?? "someone"}: ${r.acknowledgement.reason}`
                          : ""}
                      </div>
                    </div>
                    <StatusBadge
                      status={r.status}
                      label="Acknowledged"
                      variant="success"
                    />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      {acknowledging ? (
        <AcknowledgeDialog
          branchId={branchId}
          restore={acknowledging}
          onClose={() => setAcknowledging(null)}
          onDone={() => {
            setAcknowledging(null);
            setNotice(
              "Restore acknowledged. The counter can be given offline permission the next time it is online.",
            );
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

function AcknowledgeDialog({
  branchId,
  restore,
  onClose,
  onDone,
}: {
  branchId: string;
  restore: OfflineCounterRestoreView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  async function acknowledge() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await counterRestoreApi(branchId).acknowledge(restore.id, {
        reason: reason.trim(),
      });
      if (mounted.current) onDone();
    } catch (err) {
      if (mounted.current) setError(message(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="Restored counter: acknowledge"
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
            disabled={busy || !reason.trim()}
            loading={busy}
            onClick={() => void acknowledge()}
          >
            Acknowledge restore
          </ModalButton>
        </ModalFooter>
      }
    >
      <p>
        {restore.terminalLabel ?? "This counter"}: {whatMayBeMissing(restore)}
      </p>
      <p>
        Check the receipts printed, the cash in the drawer and the stock on the
        shelf since {when(lostSince(restore))} against the sales the server has.
        Record anything missing (a stock adjustment, a cash count) before you
        acknowledge.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <FormField
        as="textarea"
        label="How receipts, cash and stock were checked"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        required
        disabled={busy}
      />
    </Modal>
  );
}
