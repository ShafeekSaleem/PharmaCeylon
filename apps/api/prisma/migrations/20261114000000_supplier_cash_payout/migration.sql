-- P6 #174: supplier cash payouts are approved on the web and paid out at the counter (revised D10).
-- Approval records exact payment material; execution posts the ledger payment and drawer cash movement.
CREATE TYPE "SupplierCashPayoutStatus" AS ENUM ('prepared', 'approved', 'executed', 'cancelled');

CREATE TABLE supplier_cash_payout (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  branch_id uuid NOT NULL REFERENCES branch(id),
  supplier_id uuid NOT NULL REFERENCES supplier(id),
  payout_number text NOT NULL,
  status "SupplierCashPayoutStatus" NOT NULL DEFAULT 'prepared',
  amount numeric(14, 2) NOT NULL,
  paid_on date NOT NULL,
  reference text,
  notes text,
  allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  purchase_order_id uuid REFERENCES purchase_order(id),
  approval_version integer NOT NULL DEFAULT 1,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  requested_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execution_approval_id uuid,
  approved_by uuid,
  approved_at timestamp(3),
  executed_by uuid,
  executed_at timestamp(3),
  supplier_payment_id uuid,
  cancelled_by uuid,
  cancelled_at timestamp(3),
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_cash_payout_shape CHECK (
    amount > 0 AND approval_version = 1 AND jsonb_typeof(allocations) = 'array'
    AND ((status = 'executed') = (supplier_payment_id IS NOT NULL AND executed_by IS NOT NULL AND executed_at IS NOT NULL))
    AND ((status = 'cancelled') = (cancelled_at IS NOT NULL))
  )
);
CREATE UNIQUE INDEX supplier_cash_payout_tenant_id_payout_number_key ON supplier_cash_payout (tenant_id, payout_number);
CREATE INDEX supplier_cash_payout_tenant_id_branch_id_status_idx ON supplier_cash_payout (tenant_id, branch_id, status);
CREATE UNIQUE INDEX supplier_cash_payout_one_open_per_supplier_branch ON supplier_cash_payout (tenant_id, branch_id, supplier_id)
  WHERE status IN ('prepared', 'approved');

CREATE FUNCTION pc_supplier_cash_payout_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.branch_id, NEW.supplier_id, NEW.payout_number, NEW.amount,
         NEW.paid_on, NEW.reference, NEW.notes, NEW.allocations, NEW.purchase_order_id,
         NEW.approval_version, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.branch_id, OLD.supplier_id, OLD.payout_number, OLD.amount,
         OLD.paid_on, OLD.reference, OLD.notes, OLD.allocations, OLD.purchase_order_id,
         OLD.approval_version, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'Supplier cash payout content is immutable; cancel it and prepare a new one';
  END IF;
  IF OLD.status IN ('executed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A finished supplier cash payout cannot change state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_cash_payout_immutable BEFORE UPDATE ON supplier_cash_payout
  FOR EACH ROW EXECUTE FUNCTION pc_supplier_cash_payout_immutable();

CREATE POLICY pc_tenant_isolation ON supplier_cash_payout
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE management_approval DROP CONSTRAINT management_approval_shape;
ALTER TABLE management_approval ADD CONSTRAINT management_approval_shape CHECK (
  document_version > 0 AND document_digest ~ '^[0-9a-f]{64}$' AND policy_version = 1
  AND jsonb_typeof(material) = 'object' AND length(trim(reason)) > 0
  AND ((document_type = 'purchase_order' AND authorized_action = 'purchase_order.receive')
    OR (document_type = 'transfer' AND authorized_action = 'transfer.ship')
    OR (document_type = 'goods_return' AND authorized_action = 'goods_return.complete')
    OR (document_type = 'stocktake' AND authorized_action = 'stocktake.post')
    OR (document_type = 'held_adjustment' AND authorized_action = 'held_adjustment.post')
    OR (document_type = 'held_delivery' AND authorized_action = 'held_delivery.post')
    OR (document_type = 'sale_refund' AND authorized_action = 'sale_refund.execute')
    OR (document_type = 'prepared_receipt' AND authorized_action = 'prepared_receipt.post')
    OR (document_type = 'offline_stock_resolution' AND authorized_action = 'offline_stock_resolution.execute')
    OR (document_type = 'offline_journal_settlement' AND authorized_action = 'offline_journal_settlement.execute')
    OR (document_type = 'supplier_cash_payout' AND authorized_action = 'supplier_cash_payout.execute'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
) NOT VALID;
