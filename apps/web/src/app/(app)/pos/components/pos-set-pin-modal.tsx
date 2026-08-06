"use client";

import { useState } from "react";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { setMyPosPin } from "../services/pos-api";
import css from "../pos.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
};

/** Pharmacist sets a short till PIN so cashiers can co-sign without sharing full login. */
export function PosSetPinModal({ open, onClose, onSaved, onError }: Props) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!/^\d{4,8}$/.test(pin)) {
      onError("Till PIN must be 4–8 digits");
      return;
    }
    if (pin !== confirm) {
      onError("PIN confirmation does not match");
      return;
    }
    if (password.length < 8) {
      onError("Enter your login password to confirm");
      return;
    }
    setSaving(true);
    try {
      await setMyPosPin(pin, password);
      onSaved();
      setPin("");
      setConfirm("");
      setPassword("");
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not set till PIN");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set till PIN"
      description="Cashiers will use this short PIN to get your co-sign on controlled sales — you keep your login password private."
      size="sm"
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void save()} loading={saving}>
            Save PIN
          </ModalButton>
        </ModalFooter>
      }
    >
      <div className={css.formGrid}>
        <label className={css.field}>
          <span className={css.fieldLabel}>New PIN (4–8 digits)</span>
          <input
            className={css.control}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>Confirm PIN</span>
          <input
            className={css.control}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>Your login password</span>
          <input
            className={css.control}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
