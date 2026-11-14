"use client";

import { Alert } from "@/components/alert";
import { CounterHandoff, Modal, ModalButton, ModalFooter } from "@/components/ui";
import css from "../inventory.module.css";

/** The fields both dialogs need from a batch, whether it came from a list row or the stock sheet. */
export type QuarantineTarget = {
  id: string;
  batchNo: string;
  productName: string;
  /** On hand less what is already held or reserved — expired units included, since holding expired stock is the point. */
  holdableQty: number;
  quarantinedQty: number;
  expired: boolean;
  quarantineReason: string | null;
};

/**
 * Hold units back from sale and transfer. Counter-only (#173): the web explains where to finish;
 * PharmaCeylon POS posts `POST …/batches/:id/quarantine`.
 */
export function QuarantineDialog({
  target,
  onClose,
}: {
  target: QuarantineTarget | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title="Quarantine stock"
      size="sm"
      elevated
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose}>
            Close
          </ModalButton>
        </ModalFooter>
      }
    >
      {target && (
        <>
          <p>
            Hold units of <strong>{target.productName}</strong>, batch <strong>{target.batchNo}</strong>,
            back from sale and transfer. They stay on hand until they are released, written off or returned to
            the supplier.
          </p>
          {target.holdableQty <= 0 ? (
            <Alert variant="info">
              Nothing on this batch is available to quarantine — every unit is already held or reserved for a
              transfer.
            </Alert>
          ) : (
            <CounterHandoff
              variant="counter_only"
              branchName="this branch"
              action="Quarantine the stock"
              whoCan={["Pharmacist", "Inventory clerk", "Manager", "Owner"]}
            />
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Return held units to sellable stock after inspection. Counter-only (#173): posting happens in POS via
 * `POST …/batches/:id/release-quarantine`. Expired batches still cannot be released back to sale.
 */
export function ReleaseDialog({
  target,
  onClose,
}: {
  target: QuarantineTarget | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title="Release from quarantine"
      size="sm"
      elevated
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose}>
            Close
          </ModalButton>
        </ModalFooter>
      }
    >
      {target && (
        <>
          <p>
            Return held units of <strong>{target.productName}</strong>, batch <strong>{target.batchNo}</strong>,
            to sellable stock.
          </p>
          {target.quarantineReason && (
            <p className={css.fieldHint}>Held for: {target.quarantineReason}</p>
          )}
          {target.expired ? (
            <Alert variant="warning">
              This batch has expired. Expired stock can&apos;t go back on sale — write it off or return it to the
              supplier instead.
            </Alert>
          ) : (
            <CounterHandoff
              variant="counter_only"
              branchName="this branch"
              action="Release the stock"
              whoCan={["Pharmacist", "Manager", "Owner"]}
            />
          )}
        </>
      )}
    </Modal>
  );
}

/** Build a dialog target from a batch row as the API returns it. */
export function quarantineTargetFromBatch(row: {
  id: string;
  batchNo: string;
  qtyOnHand: number;
  quarantinedQty: number;
  reservedQty: number;
  expired: boolean;
  quarantineReason: string | null;
  product: { name: string };
}): QuarantineTarget {
  return {
    id: row.id,
    batchNo: row.batchNo,
    productName: row.product.name,
    holdableQty: Math.max(0, row.qtyOnHand - row.quarantinedQty - row.reservedQty),
    quarantinedQty: row.quarantinedQty,
    expired: row.expired,
    quarantineReason: row.quarantineReason,
  };
}

/**
 * Bulk-hold every sellable unit on expired batches. Counter-only (#173): POS posts
 * `POST …/inventory/quarantine-expired`.
 */
export function QuarantineExpiredDialog({
  open,
  expiredOpenBatchCount,
  onClose,
}: {
  open: boolean;
  expiredOpenBatchCount: number;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quarantine expired stock"
      size="sm"
      elevated
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose}>
            Close
          </ModalButton>
        </ModalFooter>
      }
    >
      <p>
        Hold every sellable unit on <strong>{expiredOpenBatchCount}</strong> expired batch
        {expiredOpenBatchCount === 1 ? "" : "es"} at this branch. Units already quarantined, or reserved for a
        transfer, are left as they are.
      </p>
      <CounterHandoff
        variant="counter_only"
        branchName="this branch"
        action="Quarantine expired stock"
        whoCan={["Pharmacist", "Inventory clerk", "Manager", "Owner"]}
      />
    </Modal>
  );
}