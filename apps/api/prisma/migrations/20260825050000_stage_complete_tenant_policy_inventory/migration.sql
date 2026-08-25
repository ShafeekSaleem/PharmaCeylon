-- Phase 6: stage tenant-only policies for every remaining tenant-owned table.
--
-- This migration intentionally does NOT enable row-level security. Product,
-- Batch, and Sale retain their Phase 4 canary policies (including branch
-- behaviour). The policies below make the schema-wide inventory reviewable and
-- testable before any wider staging activation.

DO $policy_inventory$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'idempotency_record',
    'branch',
    'branch_monthly_target',
    'app_user',
    'session',
    'user_branch_role',
    'role',
    'role_permission',
    'supplier',
    'supplier_invoice',
    'product_category',
    'product_tag',
    'product_tag_map',
    'product_alias',
    'product_similarity',
    'product_category_map',
    'document_sequence',
    'purchase_order',
    'purchase_order_item',
    'goods_receipt',
    'goods_receipt_item',
    'customer',
    'prescription',
    'sale_payment',
    'held_sale',
    'sale_item',
    'stock_ledger',
    'transfer',
    'transfer_item',
    'goods_return',
    'goods_return_item',
    'stocktake',
    'stocktake_line',
    'stocktake_assignment',
    'stocktake_snapshot_line',
    'stocktake_count_entry',
    'stocktake_posting',
    'stocktake_posting_line',
    'audit_event'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS "pc_tenant_isolation" ON %I',
      target_table
    );
    EXECUTE format(
      'CREATE POLICY "pc_tenant_isolation" ON %I
         USING (
           "tenant_id" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
         )
         WITH CHECK (
           "tenant_id" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
         )',
      target_table
    );
    EXECUTE format(
      'COMMENT ON POLICY "pc_tenant_isolation" ON %I IS %L',
      target_table,
      'Phase 6 staged tenant policy; RLS remains disabled pending staged rollout.'
    );
  END LOOP;
END
$policy_inventory$;
