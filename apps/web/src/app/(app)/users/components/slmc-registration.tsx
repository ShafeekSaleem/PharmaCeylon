"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { FormField, ModalButton, StatusBadge } from "@/components/ui";
import {
  fetchPharmacistRegistrations,
  recordPharmacistRegistration,
  revokePharmacistRegistration,
} from "../api";
import type { PharmacistRegistration } from "../types";
import css from "../users.module.css";

/** A YYYY-MM-DD day as the reader's local date, without a timezone shift. */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type Props = {
  userId: string;
  fullName: string;
  staffActive: boolean;
  actorIsOwner: boolean;
};

/**
 * P1 #47: a person's SLMC registration. Dispensing controlled medicines, or co-signing for them,
 * needs a current one at every branch; no role stands in for it. Only an owner records or
 * revokes it (the API checks that too).
 */
export function SlmcRegistration({ userId, fullName, staffActive, actorIsOwner }: Props) {
  const [rows, setRows] = useState<PharmacistRegistration[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<"view" | "record" | "revoke">("view");
  const [slmcNumber, setSlmcNumber] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    return fetchPharmacistRegistrations()
      .then((all) => {
        setRows(all.filter((r) => r.userId === userId));
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
  }

  useEffect(() => {
    setRows(null);
    setMode("view");
    setError(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const active = rows?.find((r) => r.status !== "revoked") ?? null;
  const earlier = rows?.filter((r) => r.status === "revoked") ?? [];

  function startRecord() {
    setSlmcNumber(active?.slmcNumber ?? "");
    setExpiresOn("");
    setError(null);
    setMode("record");
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await recordPharmacistRegistration({ userId, slmcNumber: slmcNumber.trim(), expiresOn });
      await reload();
      setMode("view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record the registration");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      await revokePharmacistRegistration(active.id, reason.trim());
      await reload();
      setReason("");
      setMode("view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke the registration");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: "1.1rem" }} aria-label="SLMC registration">
      <div className={css.miniLabel} style={{ marginBottom: "0.5rem" }}>
        SLMC registration
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}

      {loadFailed ? (
        <p className={css.mutedText}>Couldn&apos;t load registrations.</p>
      ) : rows === null ? (
        <p className={css.mutedText}>Loading…</p>
      ) : active ? (
        <p style={{ margin: "0 0 0.35rem" }}>
          <strong>{active.slmcNumber}</strong>{" "}
          <StatusBadge
            status={active.status}
            label={active.status === "current" ? "Current" : "Expired"}
            variant={active.status === "current" ? "success" : "danger"}
          />{" "}
          <span className={css.mutedText}>
            {active.status === "current" ? "until" : "expired"} {formatDay(active.expiresOn)}
          </span>
        </p>
      ) : (
        <p className={css.mutedText} style={{ margin: "0 0 0.35rem" }}>
          No current registration recorded.
        </p>
      )}
      {rows !== null && active?.status !== "current" ? (
        <p className={css.mutedText} style={{ margin: "0 0 0.35rem" }}>
          {fullName} can&apos;t dispense controlled medicines, or co-sign for them, until an owner
          records a current registration.
        </p>
      ) : null}

      {earlier.length > 0 ? (
        <details style={{ margin: "0 0 0.5rem" }}>
          <summary className={css.mutedText}>
            {earlier.length} earlier registration{earlier.length === 1 ? "" : "s"}
          </summary>
          <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem" }}>
            {earlier.map((r) => (
              <li key={r.id}>
                {r.slmcNumber} <span className={css.mutedText}>(until {formatDay(r.expiresOn)})</span>{" "}
                — revoked{r.revocationReason ? `: ${r.revocationReason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {mode === "record" ? (
        <div>
          <FormField
            label="SLMC registration number"
            value={slmcNumber}
            maxLength={32}
            onChange={(e) => setSlmcNumber(e.target.value)}
            hint="As printed on the SLMC certificate: letters, digits, / or -."
            disabled={busy}
          />
          <FormField
            label="Expires on"
            type="date"
            value={expiresOn}
            min={localToday()}
            onChange={(e) => setExpiresOn(e.target.value)}
            disabled={busy}
            required
          />
          <div className={css.actionsRow}>
            <ModalButton variant="secondary" onClick={() => setMode("view")} disabled={busy}>
              Cancel
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => void save()}
              loading={busy}
              disabled={!slmcNumber.trim() || !expiresOn}
            >
              Save registration
            </ModalButton>
          </div>
        </div>
      ) : mode === "revoke" && active ? (
        <div>
          <FormField
            as="textarea"
            label="Why is it being revoked?"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
          <div className={css.actionsRow}>
            <ModalButton variant="secondary" onClick={() => setMode("view")} disabled={busy}>
              Cancel
            </ModalButton>
            <ModalButton variant="danger" onClick={() => void revoke()} loading={busy} disabled={!reason.trim()}>
              Revoke registration
            </ModalButton>
          </div>
        </div>
      ) : actorIsOwner && rows !== null ? (
        <div className={css.actionsRow}>
          <ModalButton
            variant="secondary"
            onClick={startRecord}
            disabled={!staffActive}
            data-tooltip={staffActive ? undefined : "Reactivate the account first"}
          >
            {active ? "Renew" : "Record registration"}
          </ModalButton>
          {active ? (
            <ModalButton variant="danger" onClick={() => setMode("revoke")}>
              Revoke
            </ModalButton>
          ) : null}
        </div>
      ) : rows !== null ? (
        <p className={css.mutedText} style={{ margin: 0 }}>
          Only an owner can record or revoke registrations.
        </p>
      ) : null}
    </div>
  );
}
