"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  OfflineAssignmentView,
  OfflineTerminalDelegation,
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
import { collectUserRoles } from "@/lib/role-access";
import type { AdminUser } from "../../users/types";
import { delegationsApi, eligibleManagers } from "./delegations-api";
import css from "../settings.module.css";
import styles from "./assignment-delegations-card.module.css";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Couldn't update delegation. Try again.";

export function AssignmentDelegationsCard() {
  const { user, branchId } = useAuth();
  // Delegation is explicitly owner-only, rather than implied by role permissions.
  if (!collectUserRoles(user, branchId).includes("owner")) return null;
  if (!branchId) return <p>Select a branch to manage assignment authority.</p>;
  return <Delegations key={`${user?.id}:${branchId}`} branchId={branchId} />;
}

function Delegations({ branchId }: { branchId: string }) {
  const [data, setData] = useState<{
    view: OfflineAssignmentView;
    staff: AdminUser[];
    eligible: AdminUser[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [managerId, setManagerId] = useState("");
  const [pending, setPending] = useState<OfflineTerminalDelegation | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const api = delegationsApi(branchId);
    Promise.all([api.view(), api.staff(), api.roles()]).then(
      ([view, staff, roles]) => {
        if (!cancelled)
          setData({
            view,
            staff,
            eligible: eligibleManagers(staff, roles, branchId),
          });
      },
      (err) => {
        if (!cancelled) setError(message(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [branchId, reload]);

  async function change(
    action: () => Promise<OfflineAssignmentView>,
    success: string,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const view = await action();
      if (!mounted.current) return;
      setData((previous) => (previous ? { ...previous, view } : null));
      setManagerId("");
      setPending(null);
      setReason("");
      setNotice(success);
    } catch (err) {
      if (mounted.current) setError(message(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function grant(event: FormEvent) {
    event.preventDefault();
    if (managerId && candidates.some((p) => p.id === managerId))
      void change(
        () => delegationsApi(branchId).grant(managerId),
        "Assignment authority granted for this branch.",
      );
  }
  const name = (id: string) =>
    data?.staff.find((p) => p.id === id)?.fullName || `Staff ${id}`;
  const active = new Set(
    data?.view.delegations
      .filter((d) => d.revokedAt === null)
      .map((d) => d.managerUserId),
  );
  const candidates = data?.eligible.filter((p) => !active.has(p.id)) ?? [];
  return (
    <section
      className={css.card}
      aria-label="Offline-device assignment authority"
    >
      <h2 className={css.cardTitle}>Offline-device assignment authority</h2>
      <p className={css.cardDesc}>
        Choose who may authorize an offline device for this branch. Owners
        already have this authority. Other staff need your explicit delegation
        and the Tenant management permission; changing a role alone does not grant
        it.
      </p>
      <p className={css.rowHint}>
        This does not enable offline selling or activate a device. Activation is
        a separate online step at the chosen counter.
      </p>
      {error && !pending ? <Alert variant="error">{error}</Alert> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!data ? (
        error ? (
          <ModalButton onClick={() => setReload((n) => n + 1)}>
            Try again
          </ModalButton>
        ) : (
          <p role="status">Loading assignment authority…</p>
        )
      ) : (
        <>
          <form className={styles.form} onSubmit={grant}>
            <FormField
              as="select"
              label="Staff member"
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
              disabled={busy || candidates.length === 0}
              required
            >
              <option value="">Choose staff</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName} ({p.email})
                </option>
              ))}
            </FormField>
            <ModalButton
              type="submit"
              variant="primary"
              disabled={busy || !managerId}
              loading={busy && !pending}
            >
              Grant authority
            </ModalButton>
          </form>
          {!candidates.length ? (
            <p className={css.rowHint}>
              No additional eligible staff. Staff must be active, assigned to
              this branch and have Tenant management permission.
            </p>
          ) : null}
          <ul className={styles.list} aria-label="Delegations">
            {data.view.delegations.map((d) => (
              <li key={d.delegationId} className={styles.row}>
                <div className={styles.person}>
                  <div className={css.rowLabel}>{name(d.managerUserId)}</div>
                  <div className={css.rowHint}>
                    Granted by {name(d.delegatedByOwnerUserId)} on{" "}
                    {new Date(d.createdAt).toLocaleString()}
                  </div>
                  {d.revokedAt !== null ? (
                    <div className={css.rowHint}>
                      Revoked on {new Date(d.revokedAt).toLocaleString()}
                    </div>
                  ) : !data.eligible.some((p) => p.id === d.managerUserId) ? (
                    <div className={css.rowHint}>
                      Currently ineligible. Active branch membership and Manage
                      branches permission are still required.
                    </div>
                  ) : null}
                </div>
                <div className={styles.actions}>
                  <StatusBadge
                    status={d.revokedAt === null ? "active" : "revoked"}
                    label={d.revokedAt === null ? "Granted" : "Revoked"}
                    variant={d.revokedAt === null ? "success" : "default"}
                  />
                  {d.revokedAt === null ? (
                    <ModalButton
                      disabled={busy}
                      onClick={() => {
                        setPending(d);
                        setReason("");
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      Revoke authority
                      <span className="pc-sr-only">
                        {" "}
                        for {name(d.managerUserId)}
                      </span>
                    </ModalButton>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {!data.view.delegations.length ? (
            <p className={css.rowHint}>
              No assignment authority has been delegated at this branch.
            </p>
          ) : null}
        </>
      )}
      <Modal
        open={pending !== null}
        title="Revoke assignment authority"
        size="sm"
        canDismiss={!busy}
        onClose={() => {
          setPending(null);
          setError(null);
        }}
        footer={
          <ModalFooter>
            <ModalButton
              disabled={busy}
              onClick={() => {
                setPending(null);
                setError(null);
              }}
            >
              Cancel
            </ModalButton>
            <ModalButton
              variant="danger"
              disabled={busy || !reason.trim()}
              loading={busy}
              onClick={() => {
                if (pending && reason.trim())
                  void change(
                    () =>
                      delegationsApi(branchId).revoke(
                        pending.delegationId,
                        reason.trim(),
                      ),
                    "Assignment authority revoked for this branch.",
                  );
              }}
            >
              Revoke authority
            </ModalButton>
          </ModalFooter>
        }
      >
        <p>
          Revoke {pending ? name(pending.managerUserId) : ""}&apos;s authority
          at this branch? Any outstanding device authorization they made using
          it will also be revoked. An already activated device is not
          deactivated.
        </p>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <FormField
          as="textarea"
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          required
          disabled={busy}
        />
      </Modal>
    </section>
  );
}
