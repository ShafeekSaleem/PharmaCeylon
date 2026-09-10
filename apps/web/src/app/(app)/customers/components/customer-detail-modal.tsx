"use client";

import { useState } from "react";
import { Alert } from "@/components/alert";
import {
  Modal,
  ModalButton,
  ModalFooter,
  SegmentedTabs,
  StatusBadge,
} from "@/components/ui";
import { IconFileText, IconReceipt } from "@/components/icons";
import { useCustomerProfile } from "../hooks/use-customers";
import { formatDate, formatMoney } from "../utils";
import css from "../customers.module.css";

type Tab = "purchases" | "prescriptions" | "details";

/**
 * The dispensing record behind a customer.
 *
 * This is what the page exists for: before it, checking what someone had been
 * given meant opening the POS mid-sale. Purchases and prescriptions are shown
 * across every branch, because a customer who filled a prescription at one
 * shop and returns to another is ordinary, not an edge case.
 */
export function CustomerDetailModal({
  customerId,
  onClose,
  onEdit,
  canManage,
}: {
  customerId: string | null;
  onClose: () => void;
  onEdit: () => void;
  canManage: boolean;
}) {
  const { profile, loading, error } = useCustomerProfile(customerId);
  const [tab, setTab] = useState<Tab>("purchases");

  const customer = profile?.customer;

  return (
    <Modal
      open={customerId !== null}
      onClose={onClose}
      size="lg"
      title={customer?.fullName ?? "Customer"}
      description={
        customer
          ? [customer.phone, customer.email].filter(Boolean).join(" · ") ||
            "No contact details on record"
          : undefined
      }
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose}>Close</ModalButton>
          {canManage ? (
            <ModalButton variant="primary" onClick={onEdit}>
              Edit customer
            </ModalButton>
          ) : null}
        </ModalFooter>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      {loading ? <p className={css.muted}>Loading…</p> : null}

      {profile ? (
        <>
          {!profile.customer.isActive ? (
            <Alert variant="warning">
              This customer is deactivated. They stay off the counter picker, but
              their history below is unchanged.
            </Alert>
          ) : null}

          <div className={css.statRow}>
            <div className={css.stat}>
              <span className={css.statLabel}>Lifetime value</span>
              <span className={css.statValue}>
                {formatMoney(profile.stats.lifetimeValue)}
              </span>
            </div>
            <div className={css.stat}>
              <span className={css.statLabel}>Purchases</span>
              <span className={css.statValue}>{profile.stats.postedSaleCount}</span>
            </div>
            <div className={css.stat}>
              <span className={css.statLabel}>Last purchase</span>
              <span className={css.statValue}>
                {profile.stats.lastPurchaseAt
                  ? formatDate(profile.stats.lastPurchaseAt)
                  : "—"}
              </span>
            </div>
          </div>

          <SegmentedTabs
            ariaLabel="Customer record"
            items={[
              { id: "purchases", label: "Purchases", count: profile.sales.length },
              {
                id: "prescriptions",
                label: "Prescriptions",
                count: profile.prescriptions.length,
              },
              { id: "details", label: "Details" },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === "purchases" ? (
            profile.sales.length === 0 ? (
              <p className={css.empty}>
                <IconReceipt size={18} /> No purchases recorded yet.
              </p>
            ) : (
              <div className={css.historyList}>
                {profile.sales.map((sale) => (
                  <div key={sale.id} className={css.historyRow}>
                    <div className={css.historyMain}>
                      <span className={css.historyTitle}>{sale.invoiceNo}</span>
                      <span className={css.historyMeta}>
                        {formatDate(sale.soldAt)} · {sale.branch.name} ·{" "}
                        {sale._count.items}{" "}
                        {sale._count.items === 1 ? "item" : "items"}
                        {sale.prescription
                          ? ` · Rx ${sale.prescription.rxNumber}`
                          : ""}
                      </span>
                    </div>
                    <div className={css.historyRight}>
                      <span className={css.historyAmount}>
                        {formatMoney(sale.grandTotal)}
                      </span>
                      {sale.status !== "posted" ? (
                        <StatusBadge status={sale.status} />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : null}

          {tab === "prescriptions" ? (
            profile.prescriptions.length === 0 ? (
              <p className={css.empty}>
                <IconFileText size={18} /> No prescriptions recorded yet.
              </p>
            ) : (
              <div className={css.historyList}>
                {profile.prescriptions.map((rx) => {
                  const expired =
                    rx.validUntil !== null && new Date(rx.validUntil) < new Date();
                  return (
                    <div key={rx.id} className={css.historyRow}>
                      <div className={css.historyMain}>
                        <span className={css.historyTitle}>{rx.rxNumber}</span>
                        <span className={css.historyMeta}>
                          {rx.patientName} · Dr {rx.doctorName} ·{" "}
                          {formatDate(rx.issuedOn)} · {rx.branch.name}
                        </span>
                      </div>
                      <div className={css.historyRight}>
                        {/* Validity is the thing a pharmacist checks first on a
                            repeat, so it earns the badge rather than a date. */}
                        {rx.validUntil ? (
                          <StatusBadge
                            status={expired ? "expired" : "active"}
                            label={
                              expired
                                ? "Expired"
                                : `Valid to ${formatDate(rx.validUntil)}`
                            }
                          />
                        ) : (
                          <span className={css.historyMeta}>No expiry</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : null}

          {tab === "details" ? (
            <dl className={css.detailList}>
              <div>
                <dt>Phone</dt>
                <dd>{profile.customer.phone ?? "—"}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{profile.customer.email ?? "—"}</dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>{profile.customer.address ?? "—"}</dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd>{profile.customer.notes ?? "—"}</dd>
              </div>
              <div>
                <dt>Registered</dt>
                <dd>{formatDate(profile.customer.createdAt)}</dd>
              </div>
            </dl>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
