-- Validate the constraint widened NOT VALID by 20261110200000 (SHARE UPDATE EXCLUSIVE: reads and
-- writes continue while existing rows are checked).
ALTER TABLE offline_stock_discrepancy_line VALIDATE CONSTRAINT offline_stock_discrepancy_line_shape;
