"use client";

import { useState } from "react";
import type { BranchHoursExtensionView, BranchHoursView } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { ActionButton, FormField, Modal, ModalButton, ModalFooter } from "@/components/ui";
import settingsCss from "../../settings.module.css";
import { approveHoursExtension, revokeHoursExtension } from "../hours-api";
import { branchLocalToIso, formatInBranchTime } from "../lib/hours-draft";
import css from "./branch-hours.module.css";
import { SYNC_NOTE } from "./branch-hours-editor";

type Props = {
  view: BranchHoursView;
  canEdit: boolean;
  onChanged: (view: BranchHoursView) => void;
};

/** Online-approved business extensions: extra selling time on top of the routine hours for one
 *  stretch of up to 24 hours. They never go past a mandatory limit. Saved straight away, apart
 *  from the hours form, because each one is an approval with its own approver and reason. */
export function HoursExtensionsCard({ view, canEdit, onChanged }: Props) {
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<BranchHoursExtensionView | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const zone = view.timezone;

  async function approve() {
    setError(null);
    const from = branchLocalToIso(startsAt, zone);
    const until = branchLocalToIso(endsAt, zone);
    if (!from || !until) return setError("Choose when the extension starts and ends.");
    if (!reason.trim()) return setError("Give a reason, such as “Festival night”.");
    setBusy(true);
    try {
      onChanged(await approveHoursExtension(view.branchId, { startsAt: from, endsAt: until, reason: reason.trim() }));
      setStartsAt("");
      setEndsAt("");
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't approve the extension.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking || !revokeReason.trim()) return;
    setBusy(true);
    try {
      onChanged(await revokeHoursExtension(view.branchId, revoking.id, revokeReason.trim()));
      setRevoking(null);
      setRevokeReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't revoke the extension.");
      setRevoking(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={settingsCss.card} aria-labelledby="hours-extensions">
      <div className={settingsCss.cardHead}>
        <div>
          <h2 className={settingsCss.cardTitle} id="hours-extensions">Extended selling hours</h2>
          <p className={settingsCss.cardDesc}>
            Approve extra selling time on top of the routine hours, for up to 24 hours at a time — a festival night,
            say. Times are in {zone}. An extension never goes past a mandatory limit. {SYNC_NOTE}
          </p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {view.extensions.length === 0 ? <p className={css.muted}>No upcoming extensions.</p> : null}
      {view.extensions.map((extension) => (
        <div className={css.extensionRow} key={extension.id}>
          <div>
            <div className={settingsCss.rowLabel}>
              {formatInBranchTime(extension.startsAt, zone)} – {formatInBranchTime(extension.endsAt, zone)}
            </div>
            <div className={settingsCss.rowHint}>
              {extension.reason} · approved by {extension.approvedBy.name ?? "a former member of staff"}
            </div>
          </div>
          {canEdit ? (
            <button
              type="button"
              className={`${css.linkBtn} ${css.dangerLink}`}
              onClick={() => setRevoking(extension)}
            >
              Revoke
            </button>
          ) : null}
        </div>
      ))}
      {canEdit ? (
        <div className={css.extensionForm}>
          <FormField
            label="Starts"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
          <FormField label="Ends" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          <FormField label="Reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div>
            <ActionButton variant="secondary" onClick={() => void approve()} disabled={busy}>
              Approve extension
            </ActionButton>
          </div>
        </div>
      ) : null}

      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke this extension?"
        size="sm"
        canDismiss={!busy}
        footer={
          <ModalFooter>
            <ModalButton variant="secondary" onClick={() => setRevoking(null)} disabled={busy}>
              Keep it
            </ModalButton>
            <ModalButton variant="danger" onClick={() => void revoke()} loading={busy} disabled={!revokeReason.trim()}>
              Revoke
            </ModalButton>
          </ModalFooter>
        }
      >
        <p className={settingsCss.rowHint} style={{ fontSize: "0.85rem" }}>
          Counters that already have it keep it until their next sync.
        </p>
        <FormField label="Reason" value={revokeReason} maxLength={500} onChange={(e) => setRevokeReason(e.target.value)} />
      </Modal>
    </section>
  );
}
