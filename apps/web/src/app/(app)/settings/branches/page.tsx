"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, StatusBadge, DataTable, type Column } from "@/components/ui";
import { IconPlus, IconEdit, IconMapPin } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import { notifyBranchesChanged } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../settings.module.css";
import { fetchAllBranches } from "./api";
import { BranchFormModal } from "./components/branch-form-modal";
import type { Branch } from "./types";

export default function BranchesPage() {
  const { permissionKeys } = usePermissions();
  const { refreshUser } = useAuth();
  const canManage = permissionKeys.includes("tenant.branches_manage");

  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBranches(await fetchAllBranches());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load branches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAdd() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(branch: Branch) {
    setEditing(branch);
    setModalOpen(true);
  }

  function handleSaved(saved: Branch) {
    setBranches((prev) => {
      const exists = prev.some((b) => b.id === saved.id);
      return exists ? prev.map((b) => (b.id === saved.id ? saved : b)) : [...prev, saved];
    });
    notifyBranchesChanged();
    void refreshUser();
  }

  const columns: Column<Branch>[] = [
    { key: "code", header: "Code", sortable: true },
    { key: "name", header: "Name", sortable: true },
    { key: "city", header: "City", sortable: true, render: (b) => b.city ?? "—" },
    { key: "phone", header: "Phone", render: (b) => b.phone ?? "—" },
    { key: "timezone", header: "Timezone" },
    {
      key: "licence",
      header: "Licence",
      getValue: (b) => b.pharmacyLicenceExpiry ?? "",
      sortable: true,
      render: (b) => {
        if (!b.pharmacyLicenceNo) return <span className={css.mutedText}>Not recorded</span>;
        const expired = Boolean(b.pharmacyLicenceExpiry && new Date(b.pharmacyLicenceExpiry) < new Date());
        return (
          <span className={expired ? css.dangerText : undefined}>
            {b.pharmacyLicenceNo}{expired ? " · Expired" : ""}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      getValue: (b) => b.isActive ? "active" : "inactive",
      sortable: true,
      render: (b) => (
        <StatusBadge
          status={b.isActive ? "active" : "inactive"}
          variant={b.isActive ? "success" : "muted"}
          label={b.isActive ? "Active" : "Inactive"}
        />
      ),
    },
    {
      key: "actions",
      header: <span className={css.srOnly}>Actions</span>,
      align: "right",
      width: "52px",
      render: (b) => canManage ? (
        <button
          type="button"
          className={css.iconGhostBtn}
          aria-label={`Edit ${b.name}`}
          onClick={(event) => { event.stopPropagation(); openEdit(b); }}
        >
          <IconEdit size={14} />
        </button>
      ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Branches"
        description="Physical locations under this tenant. Staff are assigned roles per branch."
        actions={
          canManage ? (
            <ActionButton icon={<IconPlus size={16} />} onClick={openAdd}>
              Add Branch
            </ActionButton>
          ) : undefined
        }
      />
      {error ? <Alert variant="error">{error}</Alert> : null}

      <DataTable
        columns={columns}
        data={branches}
        rowKey={(branch) => branch.id}
        loading={loading}
        pageSize={10}
        emptyIcon={<IconMapPin size={28} />}
        emptyTitle="No branches yet"
        emptyDescription="Add your first pharmacy location to start assigning staff and stock."
        onRowClick={canManage ? openEdit : undefined}
      />

      {!canManage ? (
        <p className={css.rowHint} style={{ marginTop: "0.5rem" }}>
          <IconMapPin size={12} /> Only owners and managers can add or edit branches.
        </p>
      ) : null}

      <BranchFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={handleSaved}
        branch={editing}
      />
    </div>
  );
}
