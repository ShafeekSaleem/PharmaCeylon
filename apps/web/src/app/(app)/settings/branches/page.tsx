"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, StatusBadge } from "@/components/ui";
import { IconPlus, IconEdit, IconMapPin } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { fetchAllBranches } from "./api";
import { BranchFormModal } from "./components/branch-form-modal";
import type { Branch } from "./types";

export default function BranchesPage() {
  const { permissionKeys } = usePermissions();
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
  }

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

      <div className={css.card}>
        {loading ? (
          <p className={css.rowHint}>Loading branches…</p>
        ) : branches.length === 0 ? (
          <p className={css.rowHint}>No branches yet.</p>
        ) : (
          <table className={css.table}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>City</th>
                <th>Phone</th>
                <th>Timezone</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.id}>
                  <td>{b.code}</td>
                  <td>{b.name}</td>
                  <td>{b.city ?? "—"}</td>
                  <td>{b.phone ?? "—"}</td>
                  <td>{b.timezone}</td>
                  <td>
                    <StatusBadge
                      status={b.isActive ? "active" : "inactive"}
                      variant={b.isActive ? "success" : "muted"}
                      label={b.isActive ? "Active" : "Inactive"}
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {canManage ? (
                      <button
                        type="button"
                        className={css.iconGhostBtn}
                        aria-label={`Edit ${b.name}`}
                        onClick={() => openEdit(b)}
                      >
                        <IconEdit size={14} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
