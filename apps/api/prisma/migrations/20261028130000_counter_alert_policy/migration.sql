-- W7: counter alert types and their recipient roles. Null keeps the defaults (every type to
-- owners and managers). Versioned like the branch counter policy; W9 delivers the alerts.
ALTER TABLE "tenant_settings"
  ADD COLUMN "counter_alert_policy" JSONB,
  ADD COLUMN "counter_alert_policy_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_counter_alert_policy_version_positive"
  CHECK ("counter_alert_policy_version" > 0);
