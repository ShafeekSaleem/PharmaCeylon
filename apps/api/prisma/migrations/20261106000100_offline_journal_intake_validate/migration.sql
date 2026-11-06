-- P5 #51: validate the constraints the previous migration added NOT VALID, in their own
-- transaction: VALIDATE takes SHARE UPDATE EXCLUSIVE, so sales and shifts carry on meanwhile.

ALTER TABLE "sale" VALIDATE CONSTRAINT "sale_stock_posting_offline_check";

ALTER TABLE "till_shift" VALIDATE CONSTRAINT "till_shift_shape";
