-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "business_registration_no" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'LKR',
ADD COLUMN     "date_format" TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
ADD COLUMN     "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "tenant_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "show_sales_today_widget" BOOLEAN NOT NULL DEFAULT true,
    "show_low_stock_widget" BOOLEAN NOT NULL DEFAULT true,
    "show_expiring_batches_widget" BOOLEAN NOT NULL DEFAULT true,
    "show_top_products_widget" BOOLEAN NOT NULL DEFAULT true,
    "show_recent_activity_widget" BOOLEAN NOT NULL DEFAULT false,
    "show_branch_performance_widget" BOOLEAN NOT NULL DEFAULT true,
    "pos_quick_add_enabled" BOOLEAN NOT NULL DEFAULT true,
    "pos_held_sales_enabled" BOOLEAN NOT NULL DEFAULT true,
    "pos_require_customer" BOOLEAN NOT NULL DEFAULT false,
    "pos_auto_print_receipt" BOOLEAN NOT NULL DEFAULT true,
    "pos_default_payment_method" TEXT NOT NULL DEFAULT 'cash',
    "pos_max_discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "receipt_paper_size" TEXT NOT NULL DEFAULT '80mm',
    "receipt_copies" INTEGER NOT NULL DEFAULT 1,
    "receipt_header_text" TEXT,
    "receipt_footer_text" TEXT,
    "receipt_show_logo" BOOLEAN NOT NULL DEFAULT true,
    "receipt_show_vat_breakdown" BOOLEAN NOT NULL DEFAULT true,
    "receipt_show_staff_name" BOOLEAN NOT NULL DEFAULT true,
    "receipt_show_loyalty_points" BOOLEAN NOT NULL DEFAULT false,
    "default_product_view" TEXT NOT NULL DEFAULT 'grid',
    "show_controlled_badge_in_lists" BOOLEAN NOT NULL DEFAULT true,
    "vat_rate_percent" DECIMAL(5,2),
    "vat_calculation_method" TEXT NOT NULL DEFAULT 'exclusive',
    "prescription_tax_exempt" BOOLEAN NOT NULL DEFAULT true,
    "show_tax_breakdown_on_documents" BOOLEAN NOT NULL DEFAULT true,
    "low_stock_threshold_units" INTEGER NOT NULL DEFAULT 20,
    "expiry_warning_days" INTEGER NOT NULL DEFAULT 30,
    "default_stock_view" TEXT NOT NULL DEFAULT 'batch',
    "stock_picking_method" TEXT NOT NULL DEFAULT 'fefo',
    "barcode_adjustments_enabled" BOOLEAN NOT NULL DEFAULT true,
    "block_expired_batch_sales_at_pos" BOOLEAN NOT NULL DEFAULT true,
    "require_batch_expiry_on_goods_receipt" BOOLEAN NOT NULL DEFAULT true,
    "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "po_number_prefix" TEXT NOT NULL DEFAULT 'PO-',
    "default_supplier_payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "auto_receive_on_invoice_match" BOOLEAN NOT NULL DEFAULT false,
    "default_return_window_days" INTEGER NOT NULL DEFAULT 14,
    "require_transfer_reason_note" BOOLEAN NOT NULL DEFAULT true,
    "stocktake_default_count_method" TEXT NOT NULL DEFAULT 'full',
    "stocktake_variance_tolerance_percent" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "alert_email_digest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "alert_notify_owner" BOOLEAN NOT NULL DEFAULT true,
    "alert_notify_manager" BOOLEAN NOT NULL DEFAULT true,
    "alert_notify_pharmacist" BOOLEAN NOT NULL DEFAULT false,
    "alert_notify_inventory_clerk" BOOLEAN NOT NULL DEFAULT true,
    "approval_required_po_threshold" DECIMAL(14,2),
    "approval_required_for_branch_transfers" BOOLEAN NOT NULL DEFAULT true,
    "approval_required_return_threshold" DECIMAL(14,2),
    "default_report_period" TEXT NOT NULL DEFAULT 'this_month',
    "show_footfall_analytics" BOOLEAN NOT NULL DEFAULT true,
    "weekly_summary_email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "session_timeout_minutes" INTEGER NOT NULL DEFAULT 30,
    "audit_log_retention_days" INTEGER NOT NULL DEFAULT 365,
    "password_min_length" INTEGER NOT NULL DEFAULT 8,
    "password_require_number_or_symbol" BOOLEAN NOT NULL DEFAULT true,
    "password_expiry_days" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_settings_tenant_id_key" ON "tenant_settings"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
