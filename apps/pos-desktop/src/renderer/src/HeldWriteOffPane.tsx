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
  const qty = detail?.qty ?? 1;
  const unit = "tabs";

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
            The counter cannot post until a manager runs POST /inventory/held-adjustments/:id/accept with approvalId, expectedVersion and expectedDigest. Accept and reject are web actions, not counter buttons.
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
            Posting is the signed command POST /api/v1/inventory/held-adjustments/:id/post with body heldAdjustmentId and approvalEvidenceId set to the displayed executionApprovalId.
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
            Held write-off posting is online only. The desktop does not queue it on the sale journal.
          </div>
        </div>
      )}
      {phase === "confirm" && (
        <div className={cx(ui.note, ui.warn)} role="status">
          <Icon name="alert-triangle" />
          <div>
            <b>Confirm the physical write-off</b>
            {qty} {unitWord(unit, qty)} of {item.reference} will leave stock now. Ctrl+Enter posts.
          </div>
        </div>
      )}
      {phase === "processing" && (
        <div className={cx(ui.note, ui.info)} role="status">
          <Icon name="clock" />
          <div>
            <b>Posting…</b>
            The signed command is in flight. Don't send a second command.
          </div>
        </div>
      )}
      {phase === "success" && (
        <div className={cx(ui.note, ui.ok)} role="status">
          <Icon name="check-circle" />
          <div>
            <b>Written off</b>
            Result held_adjustment.posted · status accepted.
          </div>
        </div>
      )}
      <div className={cx(ui.kvs, styles.facts)}>
        <div className={ui.kv}>
          Kind<b>{detail?.kind ?? "—"}</b>
        </div>
        <div className={ui.kv}>
          Quantity<b>{qty} {unitWord(unit, qty)}</b>
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
          Status<b>{status}</b>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "var(--pos-text-3)" }}>
        value is null without costs.view.
      </p>
      {error && (
        <p className={cx(ui.badText, styles.result)} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
