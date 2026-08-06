"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconChevronDown } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { listPosApprovers, type PosApprover } from "../services/pos-api";
import css from "../pos.module.css";

type Props = {
  open: boolean;
  warnings?: string[];
  onClose: () => void;
  onApprove: (approval: { approverUserId: string; pin: string }) => void | Promise<void>;
  onHoldInstead: () => void;
  onError: (message: string) => void;
};

/**
 * Fast till co-sign: pick pharmacist → enter PIN (or login password if no till PIN).
 * Cashier session stays logged in.
 */
export function PosPharmacistPinModal({
  open,
  warnings = [],
  onClose,
  onApprove,
  onHoldInstead,
  onError,
}: Props) {
  const listboxId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [approvers, setApprovers] = useState<PosApprover[]>([]);
  const [loading, setLoading] = useState(false);
  const [approverUserId, setApproverUserId] = useState("");
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setPin("");
      setSubmitting(false);
      setPickerOpen(false);
      return;
    }
    let active = true;
    setLoading(true);
    listPosApprovers()
      .then((rows) => {
        if (!active) return;
        setApprovers(rows);
        setApproverUserId((prev) => prev || rows[0]?.id || "");
      })
      .catch((e) => onError(e instanceof Error ? e.message : "Could not load approvers"))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, onError]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(event: MouseEvent) {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setPickerOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pickerOpen]);

  const selected = approvers.find((a) => a.id === approverUserId);

  async function submit() {
    if (!approverUserId) {
      onError("Select a pharmacist to approve");
      return;
    }
    if (pin.trim().length < 4) {
      onError(selected?.hasPosPin ? "Enter the till PIN" : "Enter the approver password");
      return;
    }
    setSubmitting(true);
    try {
      await onApprove({ approverUserId, pin: pin.trim() });
    } catch {
      /* parent shows toast; keep modal open for retry */
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pharmacist approval"
      description="Enter the approver PIN to dispense controlled medicines."
      size="sm"
      footer={
        <ModalFooter className={css.pinModalFooter}>
          <ModalButton onClick={onHoldInstead} disabled={submitting}>
            Hold
          </ModalButton>
          <span className={css.pinModalFooterSpacer} />
          <ModalButton onClick={onClose} disabled={submitting}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit()} loading={submitting}>
            Approve &amp; complete
          </ModalButton>
        </ModalFooter>
      }
    >
      <div className={css.pinModalBody}>
        {warnings.length > 0 && (
          <ul className={css.pinWarningList}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        {loading ? (
          <p className={css.pickerEmpty}>Loading approvers…</p>
        ) : approvers.length === 0 ? (
          <p className={css.pickerEmpty}>
            No pharmacist is assigned to this branch. Hold the sale and ask a supervisor.
          </p>
        ) : (
          <div className={css.pinModalFields}>
            <div className={css.field} ref={wrapRef}>
              <span className={css.fieldLabel} id={`${listboxId}-label`}>
                Approver
              </span>
              <button
                type="button"
                className={`${css.control} ${css.pinApproverTrigger}${pickerOpen ? ` ${css.pinApproverTriggerOpen}` : ""}`}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-labelledby={`${listboxId}-label`}
                aria-controls={listboxId}
                disabled={submitting}
                onClick={() => setPickerOpen((v) => !v)}
              >
                <span className={css.pinApproverValue}>
                  {selected?.fullName ?? "Select approver"}
                </span>
                <IconChevronDown size={15} className={css.pinApproverChevron} />
              </button>
              {pickerOpen && (
                <ul id={listboxId} className={css.pinApproverMenu} role="listbox">
                  {approvers.map((a) => {
                    const active = a.id === approverUserId;
                    return (
                      <li key={a.id} role="option" aria-selected={active}>
                        <button
                          type="button"
                          className={`${css.pinApproverOption}${active ? ` ${css.pinApproverOptionActive}` : ""}`}
                          onClick={() => {
                            setApproverUserId(a.id);
                            setPickerOpen(false);
                          }}
                        >
                          {a.fullName}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>Password/PIN</span>
              <input
                className={css.control}
                type="password"
                inputMode={selected?.hasPosPin ? "numeric" : "text"}
                autoComplete="off"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Password/PIN"
              />
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
