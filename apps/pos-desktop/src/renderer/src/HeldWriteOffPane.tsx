import { useCallback, useEffect, useState } from "react";
import type { CounterWorkItem, HeldWriteOffAtCounter } from "../../shared/ipc-contract";
import styles from "./CounterWork.module.css";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import {
  approvalEvidenceIdForPost,
  canPostHeldWriteOff,
  heldStatus,
  isReadOnlyHeldWriteOff,
  staleApprovalMessage,
} from "./held-writeoff-model";
import { minor, money } from "./sell-model";
import { unitWord } from "./stock-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

const rs = (amount: string | null) =>
  amount ? `Rs ${money(minor(amount))}` : "—";

const STATUS_LABELS: Record<ReturnType<typeof heldStatus>, string> = {
  awaiting_approval: "Waiting for approval",
  approved: "Approved",
  accepted: "Written off",
  rejected: "Rejected",
};

export type HeldWriteOffPhase = "ready" | "confirm" | "processing" | "success";

export function useHeldWriteOffState(
  item: CounterWorkItem,
  staleError: string | null,
  onStaleError: (message: string | null) => void,
) {
  const [detail, setDetail] = useState<HeldWriteOffAtCounter | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<HeldWriteOffPhase>("ready");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void invoke(() => window.pos.heldWriteOffsAtCounter()).then((result) => {
      setLoading(false);
      if (result.ok) {
        const row = result.value.find((r) => r.id === item.id) ?? null;
        setDetail(row);
        if (staleError && item.approval.state === "matches") onStaleError(null);
      }
    });
  }, [item.id, item.approval.state, staleError, onStaleError]);

  useEffect(() => {
    setLoading(true);
    setPhase("ready");
    setError(null);
    load();
  }, [load, item.id]);

  const status = heldStatus(item, detail);
  return { detail, loading, phase, setPhase, error, setError, status, load, readOnly: isReadOnlyHeldWriteOff(status) };
}

export async function postHeldWriteOffItem(
  item: CounterWorkItem,
  detail: HeldWriteOffAtCounter | null,
  onStaleError: (message: string | null) => void,
): Promise<{ ok: true; alreadyApplied: boolean } | { ok: false; message: string }> {
  const evidenceId = approvalEvidenceIdForPost(detail, item);
  const result = await invoke(() =>
    window.pos.postHeldWriteOff({
      heldAdjustmentId: item.id,
      approvalEvidenceId: evidenceId,
    }),
  );
  if (!result.ok) {
    const stale = staleApprovalMessage(result.error.code, result.error.message);
    if (stale) onStaleError(stale);
    return { ok: false, message: result.error.message };
  }
  return { ok: true, alreadyApplied: result.value.alreadyApplied };
}

export function HeldWriteOffBody({
  item,
  state,
  staleError,
  online,
}: {
  item: CounterWorkItem;
  state: ReturnType<typeof useHeldWriteOffState>;
  staleError: string | null;
  online: boolean;
}) {
  const { detail, loading, phase, status, error } = state;
  // The quantity comes only from the server row: never guess one for an irreversible post.
  const qty = detail?.qty ?? null;
  const qtyText = qty === null ? "Quantity unavailable" : `${qty} ${unitWord(null, qty)}`;

  if (loading) {
    return (
      <div className={styles.content}>
        <div className={cx(ui.note, styles.waiting)} role="status">
          <Icon name="clock" />
          <div>Loading the held write-off…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.content}>
      {status === "awaiting_approval" && (
        <div className={cx(ui.note, ui.warn)} role="status">
          <Icon name="alert-triangle" />
          <div>
            <b>Waiting for accept on the web</b>
            A manager has to approve this write-off on the web before it can be posted here.
          </div>
        </div>
      )}
      {status === "rejected" && (
        <div className={cx(ui.note, ui.bad)} role="status">
          <Icon name="alert-triangle" />
          <div>
            <b>This request was rejected</b>
            {detail?.decisionNote ? ` Decision note (web): “${detail.decisionNote}”` : ""} Nothing moved.
          </div>
        </div>
      )}
      {status === "approved" && phase === "ready" && !staleError && (
        <div className={cx(ui.note, ui.info)} role="note">
          <Icon name="info" />
          <div>
            <b>Ready to post</b>
            A manager has approved this write-off. Check the details, then post it to take the stock off.
          </div>
        </div>
      )}
      {staleError && (
        <div className={cx(ui.note, ui.bad)} role="alert">
          <Icon name="alert-triangle" />
          <div>
            <b>This approval is no longer valid</b>
            {staleError}
          </div>
        </div>
      )}
      {!online && (
        <div className={cx(ui.note, ui.bad)} role="status">
          <Icon name="wifi-off" />
          <div>
            <b>Stock operations need the server</b>
            A write-off can only be posted while this counter is connected. It is not saved for later.
          </div>
        </div>
      )}
      {status === "approved" && !detail && (
        <div className={cx(ui.note, ui.warn)} role="status">
          <Icon name="alert-triangle" />
          <div>
            <b>Quantity unavailable</b>
            This counter could not load the details of this write-off, so it cannot be posted from here. Try again, or post it on the web.
          </div>
        </div>
      )}
      {phase === "confirm" && qty !== null && (
        <div className={cx(ui.note, ui.warn)} role="status">
          <Icon name="alert-triangle" />
          <div>
            <b>Confirm the physical write-off</b>
            {qty} {unitWord(null, qty)} of {item.reference} will leave stock now. Ctrl+Enter posts.
          </div>
        </div>
      )}
      {phase === "processing" && (
        <div className={cx(ui.note, ui.info)} role="status">
          <Icon name="clock" />
          <div>
            <b>Posting…</b>
            Please wait. Don't post it again.
          </div>
        </div>
      )}
      {phase === "success" && (
        <div className={cx(ui.note, ui.ok)} role="status">
          <Icon name="check-circle" />
          <div>
            <b>Written off</b>
            The stock has been taken off.
          </div>
        </div>
      )}
      <div className={cx(ui.kvs, styles.facts)}>
        <div className={ui.kv}>
          Reason<b>{detail?.kindLabel ?? "—"}</b>
        </div>
        <div className={ui.kv}>
          Quantity<b>{qtyText}</b>
        </div>
        <div className={ui.kv}>
          Value<b>{rs(detail?.value ?? item.amount)}</b>
        </div>
        <div className={ui.kv}>
          From quarantine<b>{detail?.fromQuarantine ? "Yes" : "No"}</b>
        </div>
        <div className={ui.kv}>
          Product / batch<b>{item.subject ?? "—"} · {item.reference}</b>
        </div>
        <div className={ui.kv}>
          Status<b>{STATUS_LABELS[status]}</b>
        </div>
      </div>
      {!detail?.value && !item.amount && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pos-text-3)" }}>
          The value is only shown to people who can see costs.
        </p>
      )}
      {error && (
        <p className={cx(ui.badText, styles.result)} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
