-- Two parallel migrations each re-added management_approval_shape with only their own new pair:
-- 20261029000000_prepared_receipt_and_return_split (prepared receipts) and
-- 20261029110000_sale_refund_requests (sale refunds). Whichever ran last would drop the other's
-- pair, so this one, ordered after both, defines the full list. It only widens what the
-- constraint allows, so it applies whether or not the refunds migration has run yet.
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
