"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus, IconRefresh } from "@/components/icons";
import { ActionButton, DataTable, PageHeader, type Column } from "@/components/ui";
import type { SupplierCashPayoutView } from "@pharmaceylon/shared";
import { RolePageGuard } from "@/components/role-access/role-page-guard";
import { CashPayoutDetail } from "../components/cash-payout-detail";
import { PrepareCashPayoutModal } from "../components/prepare-cash-payout-modal";
import { PurchasingSubnav } from "../components/purchasing-subnav";
import { fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { useCashPayouts } from "../hooks/use-cash-payouts";
import { useInvoices } from "../hooks/use-ledger";
import { usePurchasingAccess } from "../hooks/use-purchasing-access";
import css from "../purchasing.module.css";
import { formatDate, formatMoney } from "../utils";

function shortPerson(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]!.charAt(0)}.` : parts[0];
}

function peopleCell(row: SupplierCashPayoutView) {
  if (row.status === "executed" && row.executor)
    return `${shortPerson(row.executor.fullName)} executed`;
  if (row.status === "approved" && row.approver)
    return `${shortPerson(row.approver.fullName)} approved`;
  if (row.requester)
  return `${shortPerson(row.requester.fullName)} prepared`;
  return "—";
}

export default function CashPayoutsPage() {
  return (
    <RolePageGuard
      permissions={["suppliers.pay"]}
      title="Your role can't authorize supplier payments"
      description="Your role can't authorize supplier payments"
    >
      <CashPayoutsContent />
    </RolePageGuard>
  );
}

function CashPayoutsContent() {
  const access = usePurchasingAccess();
  const { branchId } = useAuth();
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  useEffect(() => {
    void fetchTenantBranches().then(setBranches).catch(() => setBranches([]));
  }, []);
  const branchName = branches.find((b) => b.id === branchId)?.name ?? "this branch";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prepareOpen, setPrepareOpen] = useState(false);
  const list = useCashPayouts({}, access.canPay && access.ready);
  const invoices = useInvoices({}, access.canPay);
  const invoiceNumbers = useMemo(
    () => new Map(invoices.rows.map((row) => [row.id, row.invoiceNumber])),
    [invoices.rows],
  );

  const selected =
    list.rows.find((row) => row.id === selectedId) ?? list.rows.find((r) => r.status === "approved") ?? list.rows[0] ?? null;

  const columns: Column<SupplierCashPayoutView>[] = [
    { key: "payoutNumber", header: "Payout", render: (row) => row.payoutNumber },
    {
      key: "supplier",
      header: "Supplier",
      render: (row) => row.supplier?.name ?? "—",
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => formatMoney(row.amount),
    },
    { key: "paidOn", header: "Paid on", render: (row) => formatDate(row.paidOn) },
    { key: "status", header: "Status", render: (row) => row.status },
    { key: "people", header: "People", render: peopleCell },
  ];

  if (!access.ready || list.loading) {
    return (
      <>
        <PurchasingSubnav />
        <p>Loading cash payouts…</p>
      </>
    );
  }

  if (list.permissionDenied) {
    return (
      <>
        <PurchasingSubnav />
        <Alert variant="error">Your role can&apos;t authorize supplier payments</Alert>
      </>
    );
  }

  return (
    <>
      <PurchasingSubnav />
      <PageHeader
        title="Cash payouts"
        description="Prepare and approve cash owed to a supplier. The counter pays approved payouts from this branch's open shift drawer."
        actions={
          <ActionButton variant="primary" onClick={() => setPrepareOpen(true)}>
            <IconPlus />
            Prepare cash payout
          </ActionButton>
        }
      />
      {list.error && (
        <Alert variant="error">
          {list.error}
          <ActionButton variant="secondary" onClick={() => void list.reload()}>
            <IconRefresh />
            Retry
          </ActionButton>
        </Alert>
      )}
      <div className={css.dashboard}>
        <div className={css.mainCol}>
          <DataTable<SupplierCashPayoutView>
            data={list.rows}
            columns={columns}
            rowKey={(row) => row.id}
            onRowClick={(row) => setSelectedId(row.id)}
            emptyTitle="No cash payouts for this branch."
          />
        </div>
        <div className={css.sideCol}>
          {selected ? (
            <CashPayoutDetail
              payout={selected}
              branchName={branchName}
              invoiceNumbers={invoiceNumbers}
              onChanged={list.reload}
            />
          ) : (
            <section className={css.sideCard}>
              <p className={css.fieldHint}>Select a payout to review or approve it.</p>
            </section>
          )}
        </div>
      </div>
      <PrepareCashPayoutModal
        open={prepareOpen}
        onClose={() => setPrepareOpen(false)}
        onPrepared={() => void list.reload()}
      />
    </>
  );
}