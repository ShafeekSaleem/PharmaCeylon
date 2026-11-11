-- Validate the constraints widened NOT VALID by 20261110100000 (SHARE UPDATE EXCLUSIVE: reads and
-- writes continue while existing rows are checked).
ALTER TABLE offline_stock_discrepancy_line VALIDATE CONSTRAINT offline_stock_discrepancy_line_shape;
ALTER TABLE management_approval VALIDATE CONSTRAINT management_approval_shape;
