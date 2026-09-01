"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert } from "@/components/alert";
import {
  IconBox,
  IconCheckCircle,
  IconSearch,
  IconShield,
  IconTrash,
  IconUserPlus,
  IconUsers,
} from "@/components/icons";
import {
  ActionButton,
  ActiveFilterBanner,
  DataTable,
  PageHeader,
  StatCard,
  StatGrid,
  StatusBadge,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { apiJson, type TenantBranch } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import { ConfirmDialog } from "../products/components/confirm-dialog";
import layoutCss from "../purchasing/purchasing.module.css";
import { fetchAdminBranches } from "./api";
import { AddStaffModal } from "./components/add-staff-modal";
import { ManageStaffModal } from "./components/manage-staff-modal";
import { ROLE_COLORS, ROLE_FILTER_OPTIONS, STATUS_FILTER_OPTIONS } from "./constants";
import { useAdminUsers } from "./hooks/use-admin-users";
import type { AdminUser, BranchFilter, RoleFilter, StatusFilter } from "./types";
import { formatDate, roleDisplayName, staffInitials } from "./utils";
import css from "./users.module.css";

const PAGE_SIZE = 10;

export default function UsersPage() {
  return (
    <Suspense fallback={<div className={layoutCss.loading}>Loading staff…</div>}>
      <UsersContent />
    </Suspense>
  );
}

function UsersContent() {
  const { user } = useAuth();
  const { permissionKeys } = usePermissions();
  const isOwner = Boolean(user?.roles.includes("owner"));
  const canCreateUsers = permissionKeys.includes("users.create");
  const canManageUsers = permissionKeys.includes("users.manage");
  const { users, loading, error, reload } = useAdminUsers();
  const searchParams = useSearchParams();

  const [branches, setBranches] = useState<TenantBranch[]>([]);
  useEffect(() => {
    void fetchAdminBranches().then(setBranches).catch(() => setBranches([]));
  }, []);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [branchFilter, setBranchFilter] = useState<BranchFilter>(
    () => searchParams.get("branchId") ?? "all",
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [ownersManagersOnly, setOwnersManagersOnly] = useState(false);
  const [multiBranchOnly, setMultiBranchOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [manageStaffId, setManageStaffId] = useState<string | null>(null);
  const manageStaff = useMemo(
    () => users.find((u) => u.id === manageStaffId) ?? null,
    [users, manageStaffId],
  );
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiJson(`/admin/users/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      void reload();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete account");
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, roleFilter, branchFilter, statusFilter, ownersManagersOnly, multiBranchOnly]);

  const branchOptions = useMemo(
    () => [
      { value: "all", label: "All branches" },
      ...branches.map((b) => ({ value: b.id, label: b.name })),
    ],
    [branches],
  );
  const branchNameById = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);

  const filteredRows = useMemo(() => {
    return users.filter((u) => {
      if (debouncedSearch) {
        const hay = `${u.fullName} ${u.email}`.toLowerCase();
        if (!hay.includes(debouncedSearch)) return false;
      }
      if (roleFilter !== "all" && !u.userBranchRoles.some((r) => r.role === roleFilter)) {
        return false;
      }
      if (branchFilter !== "all" && !u.userBranchRoles.some((r) => r.branchId === branchFilter)) {
        return false;
      }
      if (statusFilter === "active" && !u.isActive) return false;
      if (statusFilter === "inactive" && u.isActive) return false;
      if (ownersManagersOnly && !u.userBranchRoles.some((r) => r.role === "owner" || r.role === "manager")) {
        return false;
      }
      if (multiBranchOnly && new Set(u.userBranchRoles.map((r) => r.branchId)).size <= 1) {
        return false;
      }
      return true;
    });
  }, [
    users,
    debouncedSearch,
    roleFilter,
    branchFilter,
    statusFilter,
    ownersManagersOnly,
    multiBranchOnly,
  ]);

  const hasActiveFilters =
    !!debouncedSearch ||
    roleFilter !== "all" ||
    branchFilter !== "all" ||
    statusFilter !== "all" ||
    ownersManagersOnly ||
    multiBranchOnly;

  const activeFilterPills: FilterPill[] = [
    ...(roleFilter !== "all"
      ? [{ key: "role", label: ROLE_FILTER_OPTIONS.find((o) => o.value === roleFilter)?.label ?? roleFilter }]
      : []),
    ...(branchFilter !== "all"
      ? [
          {
            key: "branch",
            label: `Branch: ${branchOptions.find((o) => o.value === branchFilter)?.label ?? "Selected"}`,
          },
        ]
      : []),
    ...(statusFilter !== "all"
      ? [
          {
            key: "status",
            label: STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter)?.label ?? statusFilter,
          },
        ]
      : []),
    ...(ownersManagersOnly ? [{ key: "ownersManagers", label: "Owners & managers only" }] : []),
    ...(multiBranchOnly ? [{ key: "multiBranch", label: "Multi-branch only" }] : []),
  ];

  function clearFilters() {
    setSearch("");
    setDebouncedSearch("");
    setRoleFilter("all");
    setBranchFilter("all");
    setStatusFilter("all");
    setOwnersManagersOnly(false);
    setMultiBranchOnly(false);
  }

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [page, filteredRows]);

  const kpis = useMemo(() => {
    const total = users.length;
    const active = users.filter((u) => u.isActive).length;
    const ownersManagers = users.filter((u) =>
      u.userBranchRoles.some((r) => r.role === "owner" || r.role === "manager"),
    ).length;
    const multiBranch = users.filter(
      (u) => new Set(u.userBranchRoles.map((r) => r.branchId)).size > 1,
    ).length;
    const coveredBranches = new Set(
      users.flatMap((u) => (u.isActive ? u.userBranchRoles.map((r) => r.branchId) : [])),
    ).size;
    return { total, active, ownersManagers, multiBranch, coveredBranches };
  }, [users]);

  const columns: Column<AdminUser>[] = useMemo(
    () => [
      {
        key: "staff",
        header: "Staff",
        width: "230px",
        render: (row) => (
          <div className={css.personCell}>
            <span
              className={css.avatar}
              style={{ background: ROLE_COLORS[row.userBranchRoles[0]?.role ?? "cashier"] }}
              aria-hidden
            >
              {staffInitials(row.fullName)}
            </span>
            <div className={css.personText}>
              <button
                type="button"
                className={css.personName}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                onClick={() => setManageStaffId(row.id)}
                disabled={!canManageUsers}
              >
                {row.fullName}
              </button>
              {row.id === user?.id ? <span className={css.youBadge}>You</span> : null}
              <div className={css.personEmail}>{row.email}</div>
            </div>
          </div>
        ),
      },
      {
        key: "roles",
        header: "Roles & branches",
        width: "460px",
        render: (row) =>
          row.userBranchRoles.length === 0 ? (
            <span className={layoutCss.muted}>No roles assigned</span>
          ) : (
            <div className={css.roleChips}>
              {row.userBranchRoles.map((mapping) => (
                <span key={mapping.id} className={css.roleChip}>
                  <span
                    className={css.roleDot}
                    style={{ background: ROLE_COLORS[mapping.role] }}
                    aria-hidden
                  />
                  {roleDisplayName(mapping)} · {branchNameById.get(mapping.branchId) ?? "—"}
                </span>
              ))}
            </div>
          ),
      },
      {
        key: "status",
        header: "Status",
        width: "110px",
        render: (row) => (
          <StatusBadge status={row.isActive ? "active" : "inactive"} label={row.isActive ? "Active" : "Deactivated"} />
        ),
      },
      {
        key: "createdAt",
        header: "Added",
        width: "120px",
        render: (row) => formatDate(row.createdAt),
      },
      {
        key: "actions",
        header: "Actions",
        width: "96px",
        align: "right",
        render: (row) => {
          const targetIsOwner = row.userBranchRoles.some((r) => r.role === "owner");
          const canManage = canManageUsers && (isOwner || !targetIsOwner);
          return (
            <div className={layoutCss.actionsCell}>
              <button
                type="button"
                className={`${layoutCss.actionIcon} ${layoutCss.actionIconEdit}`}
                onClick={() => setManageStaffId(row.id)}
                disabled={!canManage}
                aria-label={`Manage ${row.fullName}`}
                data-tooltip={canManage ? "Manage staff" : "Only an owner can manage another owner"}
              >
                ✎
              </button>
              {!row.isActive ? (
                <button
                  type="button"
                  className={`${layoutCss.actionIcon} ${css.actionIconDanger}`}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTarget(row);
                  }}
                  disabled={!canManage}
                  aria-label={`Delete ${row.fullName}`}
                  data-tooltip={canManage ? "Delete account" : "Only an owner can delete another owner"}
                >
                  <IconTrash size={14} />
                </button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [branchNameById, canManageUsers, isOwner, user?.id],
  );

  return (
    <div className={layoutCss.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Staff accounts, branch assignments, and role access across your tenant."
        actions={
          canCreateUsers ? (
            <ActionButton
              icon={<IconUserPlus size={16} />}
              tooltip="Add a new staff account"
              onClick={() => setAddOpen(true)}
            >
              Add staff
            </ActionButton>
          ) : null
        }
      />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <StatGrid columns={5} className={css.kpiRow}>
        <StatCard
          size="sm"
          title="Total staff"
          value={kpis.total}
          subtitle={`Across ${branches.length} branches`}
          icon={<IconUsers size={16} />}
          iconTone="info"
          active={!hasActiveFilters}
          onClick={clearFilters}
        />
        <StatCard
          size="sm"
          title="Active"
          value={kpis.active}
          subtitle={kpis.total - kpis.active > 0 ? `${kpis.total - kpis.active} deactivated` : "All active"}
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          active={statusFilter === "active"}
          onClick={() => setStatusFilter((s) => (s === "active" ? "all" : "active"))}
        />
        <StatCard
          size="sm"
          title="Owners & managers"
          value={kpis.ownersManagers}
          subtitle="Admin-level access"
          icon={<IconShield size={16} />}
          iconTone="primary"
          active={ownersManagersOnly}
          onClick={() => setOwnersManagersOnly((v) => !v)}
        />
        <StatCard
          size="sm"
          title="Multi-branch staff"
          value={kpis.multiBranch}
          subtitle="Cover more than 1 branch"
          icon={<IconBox size={16} />}
          iconTone="warning"
          active={multiBranchOnly}
          onClick={() => setMultiBranchOnly((v) => !v)}
        />
        <StatCard
          size="sm"
          title="Branches covered"
          value={`${kpis.coveredBranches} / ${branches.length}`}
          subtitle="By an active staff member"
          icon={<IconUsers size={16} />}
          iconTone="info"
          showMenu={false}
        />
      </StatGrid>

      <div className={layoutCss.toolbar}>
        <div className={layoutCss.searchWrap}>
          <IconSearch size={15} className={layoutCss.searchIcon} />
          <input
            type="search"
            className={layoutCss.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            aria-label="Search staff"
          />
        </div>
        <InventoryFilterSelect
          label="Role"
          value={roleFilter}
          options={ROLE_FILTER_OPTIONS}
          onChange={(v) => setRoleFilter(v as RoleFilter)}
        />
        <InventoryFilterSelect
          label="Branch"
          value={branchFilter}
          options={branchOptions}
          onChange={(v) => setBranchFilter(v as BranchFilter)}
        />
        <InventoryFilterSelect
          label="Status"
          value={statusFilter}
          options={STATUS_FILTER_OPTIONS}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
        />
        <span className={layoutCss.toolbarSpacer} />
      </div>

      <ActiveFilterBanner
        active={hasActiveFilters}
        summary={`Filtered staff · ${filteredRows.length} staff member${filteredRows.length === 1 ? "" : "s"}`}
        pills={activeFilterPills}
        onClear={clearFilters}
      />

      <DataTable
        columns={columns}
        data={paged}
        rowKey={(r) => r.id}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={filteredRows.length}
        onPageChange={setPage}
        emptyTitle={hasActiveFilters ? "No staff match your filters" : "No staff yet"}
        emptyDescription={
          hasActiveFilters
            ? "Try clearing filters or adjusting your search"
            : canCreateUsers
              ? "Add your first staff account to get started"
              : "Staff accounts for this tenant will appear here"
        }
        emptyIcon={<IconUsers size={48} />}
        compact
      />

      {canCreateUsers ? (
        <AddStaffModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            void reload();
          }}
        />
      ) : null}

      {canManageUsers ? (
        <ManageStaffModal
          open={!!manageStaff}
          staff={manageStaff}
          currentUserId={user?.id ?? null}
          actorIsOwner={isOwner}
          onClose={() => setManageStaffId(null)}
          onChanged={() => {
            void reload();
          }}
          onDeleted={() => {
            setManageStaffId(null);
            void reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this account?"
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void confirmDelete()}
      >
        {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}
        <p>
          Permanently delete {deleteTarget?.fullName}&apos;s account? This can&apos;t be undone. It
          will only succeed if the account has no sales, purchases, or other activity on record.
        </p>
      </ConfirmDialog>
    </div>
  );
}
