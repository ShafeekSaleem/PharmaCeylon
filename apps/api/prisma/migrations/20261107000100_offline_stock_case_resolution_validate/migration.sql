-- Validate the widened approval shape added NOT VALID by 20261107000000 (SHARE UPDATE EXCLUSIVE:
-- reads and writes continue while existing rows are checked).
ALTER TABLE management_approval VALIDATE CONSTRAINT management_approval_shape;
