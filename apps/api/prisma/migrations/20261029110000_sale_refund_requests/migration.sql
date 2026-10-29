-- P6: a customer refund is prepared (and, over the tenant threshold, approved) remotely, and
-- executed at the counter as a separate post. Approval alone never moves stock or money.
CREATE TYPE "SaleRefundRequestStatus" AS ENUM ('prepared', 'approved', 'executed', 'cancelled');

CREATE TABLE sale_refund_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  branch_id uuid NOT NULL REFERENCES branch(id),
  sale_id uuid NOT NULL REFERENCES sale(id),
  request_number text NOT NULL,
  status "SaleRefundRequestStatus" NOT NULL DEFAULT 'prepared',
  lines jsonb NOT NULL,
  amount numeric(12, 2) NOT NULL,
  refund_method "PaymentMethod",
  reason_code text,
  reason varchar(600) NOT NULL,
  approval_required boolean NOT NULL,
  approval_version integer NOT NULL DEFAULT 1,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  requested_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execution_approval_id uuid,
  approved_by uuid,
  approved_at timestamp(3),
  executed_by uuid,
  executed_at timestamp(3),
  goods_return_id uuid UNIQUE REFERENCES goods_return(id),
  cancelled_by uuid,
  cancelled_at timestamp(3),
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sale_refund_request_shape CHECK (
    jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0 AND amount > 0
    AND approval_version = 1 AND length(trim(reason)) > 0
    AND ((status = 'executed') = (goods_return_id IS NOT NULL AND executed_by IS NOT NULL AND executed_at IS NOT NULL))
    AND ((status = 'cancelled') = (cancelled_at IS NOT NULL))
  )
);
CREATE UNIQUE INDEX sale_refund_request_tenant_id_request_number_key ON sale_refund_request (tenant_id, request_number);
CREATE INDEX sale_refund_request_tenant_id_branch_id_status_idx ON sale_refund_request (tenant_id, branch_id, status);
CREATE INDEX sale_refund_request_tenant_id_sale_id_idx ON sale_refund_request (tenant_id, sale_id);
-- One open request per sale: overlapping prepared refunds of the same units are refused early;
-- execution still re-checks the sale's remaining returnable quantity under the sale lock.
CREATE UNIQUE INDEX sale_refund_request_one_open_per_sale ON sale_refund_request (tenant_id, sale_id)
  WHERE status IN ('prepared', 'approved');

-- What was prepared is what is approved and executed: material content is immutable. To change
-- a refund, cancel it and prepare a new one, so an approval can never cover edited content.
CREATE FUNCTION pc_sale_refund_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.branch_id, NEW.sale_id, NEW.request_number, NEW.lines, NEW.amount,
         NEW.refund_method, NEW.reason_code, NEW.reason, NEW.approval_required, NEW.approval_version,
         NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.branch_id, OLD.sale_id, OLD.request_number, OLD.lines, OLD.amount,
         OLD.refund_method, OLD.reason_code, OLD.reason, OLD.approval_required, OLD.approval_version,
         OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'Prepared refund content is immutable; cancel it and prepare a new one';
  END IF;
  IF OLD.status IN ('executed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A finished refund request cannot change state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sale_refund_request_immutable BEFORE UPDATE ON sale_refund_request
  FOR EACH ROW EXECUTE FUNCTION pc_sale_refund_request_immutable();

CREATE POLICY pc_tenant_isolation ON sale_refund_request
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.

-- Allow exact approvals of prepared refunds. Every existing pair is kept, plus P6 receiving's
-- prepared_receipt pair (#90), so this and #90's later migration define the same constraint
-- whichever lands first.
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
    OR (document_type = 'prepared_receipt' AND authorized_action = 'prepared_receipt.post'))
  AND (expires_at IS NULL OR expires_at > approved_at)
  AND ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
);
