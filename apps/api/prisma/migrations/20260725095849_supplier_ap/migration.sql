-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
