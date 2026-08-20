"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { fetchAdminBranches } from "../api";
import { useAdminUsers } from "../hooks/use-admin-users";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import type { TenantBranch } from "@/lib/auth-client";
import {
  deleteRole,
  fetchPermissionCatalog,
  fetchRoles,
  updateRolePermissions,
} from "./api";
import { AssignedStaffDrawer } from "./components/assigned-staff-drawer";
import { CompareRolesView } from "./components/compare-roles-view";
import { CreateRoleModal } from "./components/create-role-modal";
import { EditRoleDetailsModal } from "./components/edit-role-details-modal";
import { PermissionGroup } from "./components/permission-group";
import { PermissionToolbar } from "./components/permission-toolbar";
import { RoleHeader } from "./components/role-header";
import { RoleSidebar } from "./components/role-sidebar";
import {
  buildPermissionIndex,
  findDependents,
  matchesFilter,
  matchesSearch,
  resolveDisableWithDependents,
  resolveEnableWithDependencies,
  sameKeySet,
  summarizeGrants,
} from "./permission-utils";
import type { PermissionGrantFilter, PermissionModule, RoleRow } from "./types";
import css from "./roles.module.css";

type PendingNav = { kind: "select-role"; roleId: string } | { kind: "compare" };

type DependencyNotice = { kind: "added" | "removed"; sourceLabel: string; affected: string[] };

type DisableConfirm = { key: string; permLabel: string; dependents: string[] };

export default function RolesPermissionsPage() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [modules, setModules] = useState<PermissionModule[]>([]);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const { users } = useAdminUsers();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<"editor" | "compare">("editor");
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [sidebarQuery, setSidebarQuery] = useState("");

  const [draftKeys, setDraftKeys] = useState<string[]>([]);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [permQuery, setPermQuery] = useState("");
  const [permFilter, setPermFilter] = useState<PermissionGrantFilter>("all");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [depNotice, setDepNotice] = useState<DependencyNotice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState<RoleRow | null>(null);
  const [editDetailsRole, setEditDetailsRole] = useState<RoleRow | null>(null);
  const [assignedStaffRole, setAssignedStaffRole] = useState<RoleRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<RoleRow | null>(null);
  const [pendingNav, setPendingNav] = useState<PendingNav | null>(null);
  const [disableConfirm, setDisableConfirm] = useState<DisableConfirm | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [roleRows, catalog, branchRows] = await Promise.all([
        fetchRoles(),
        fetchPermissionCatalog(),
        fetchAdminBranches(),
      ]);
      setRoles(roleRows);
      setModules(catalog);
      setBranches(branchRows);
      setSelectedRoleId((prev) => prev ?? sortRolesForSidebar(roleRows)[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load roles & permissions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const sidebarRoles = useMemo(() => sortRolesForSidebar(roles), [roles]);
  const compareRoles = useMemo(() => sortRolesForCompare(roles), [roles]);
  const selectedRole = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) ?? null,
    [roles, selectedRoleId],
  );
  const permIndex = useMemo(() => buildPermissionIndex(modules), [modules]);
  const moduleForKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const mod of modules) for (const perm of mod.permissions) map.set(perm.key, mod.module);
    return map;
  }, [modules]);
  const totalPermissionCount = useMemo(
    () => modules.reduce((sum, m) => sum + m.permissions.length, 0),
    [modules],
  );

  const roleStats = useMemo(() => {
    const map = new Map<string, { staffCount: number; branchCount: number }>();
    for (const user of users) {
      for (const mapping of user.userBranchRoles) {
        if (!mapping.roleId) continue;
        const entry = map.get(mapping.roleId) ?? { staffCount: 0, branchCount: 0 };
        map.set(mapping.roleId, entry);
      }
    }
    for (const [roleId] of map) {
      const staffIds = new Set<string>();
      const branchIds = new Set<string>();
      for (const user of users) {
        for (const mapping of user.userBranchRoles) {
          if (mapping.roleId === roleId) {
            staffIds.add(user.id);
            branchIds.add(mapping.branchId);
          }
        }
      }
      map.set(roleId, { staffCount: staffIds.size, branchCount: branchIds.size });
    }
    return map;
  }, [users]);

  // Load the selected role's permissions into the local draft buffer whenever
  // the selection changes — edits live here until Save, never on `roles` directly.
  useEffect(() => {
    if (selectedRole) {
      setDraftKeys(selectedRole.permissionKeys);
      setExpandedModules(new Set());
      setPermQuery("");
      setPermFilter("all");
      setSaveError(null);
      setDepNotice(null);
    }
  }, [selectedRole?.id]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirty) e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const dirty = selectedRole ? !sameKeySet(draftKeys, selectedRole.permissionKeys) : false;
  const changedCount = selectedRole
    ? draftKeys.filter((k) => !selectedRole.permissionKeys.includes(k)).length +
      selectedRole.permissionKeys.filter((k) => !draftKeys.includes(k)).length
    : 0;
  const draftSet = useMemo(() => new Set(draftKeys), [draftKeys]);
  const summary = useMemo(() => summarizeGrants(modules, draftSet), [modules, draftSet]);
  const selectedStats = selectedRole ? roleStats.get(selectedRole.id) : undefined;

  function showNotice(notice: DependencyNotice) {
    setDepNotice(notice);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setDepNotice(null), 7000);
  }

  function expandModuleFor(key: string) {
    const mod = moduleForKey.get(key);
    if (mod) setExpandedModules((prev) => new Set(prev).add(mod));
  }

  function togglePermission(key: string) {
    const granted = draftSet.has(key);
    if (!granted) {
      const { nextKeys, added } = resolveEnableWithDependencies(key, draftSet, permIndex);
      setDraftKeys([...nextKeys]);
      expandModuleFor(key);
      if (added.length) {
        added.forEach((a) => expandModuleFor(a.key));
        showNotice({
          kind: "added",
          sourceLabel: permIndex.get(key)?.label ?? key,
          affected: added.map((a) => a.label),
        });
      }
      return;
    }

    const dependents = findDependents(key, draftSet, permIndex);
    if (dependents.length > 0) {
      setDisableConfirm({
        key,
        permLabel: permIndex.get(key)?.label ?? key,
        dependents: dependents.map((d) => d.label),
      });
      return;
    }
    const next = new Set(draftSet);
    next.delete(key);
    setDraftKeys([...next]);
  }

  function confirmCascadeDisable() {
    if (!disableConfirm) return;
    const { nextKeys } = resolveDisableWithDependents(disableConfirm.key, draftSet, permIndex);
    setDraftKeys([...nextKeys]);
    setDisableConfirm(null);
  }

  function selectAllInGroup(keys: string[], grant: boolean) {
    const next = new Set(draftSet);
    if (grant) {
      for (const key of keys) {
        const { nextKeys } = resolveEnableWithDependencies(key, next, permIndex);
        nextKeys.forEach((k) => next.add(k));
      }
    } else {
      for (const key of keys) next.delete(key);
    }
    setDraftKeys([...next]);
  }

  function requestSelectRole(roleId: string) {
    if (roleId === selectedRoleId) return;
    if (dirty) {
      setPendingNav({ kind: "select-role", roleId });
      return;
    }
    setSelectedRoleId(roleId);
  }

  function requestCompareView() {
    if (dirty) {
      setPendingNav({ kind: "compare" });
      return;
    }
    setView("compare");
  }

  function resolvePendingNav() {
    if (!pendingNav) return;
    if (pendingNav.kind === "select-role") setSelectedRoleId(pendingNav.roleId);
    else setView("compare");
    setPendingNav(null);
  }

  async function saveChanges() {
    if (!selectedRole) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateRolePermissions(selectedRole.id, draftKeys);
      setRoles((prev) =>
        prev.map((r) => (r.id === selectedRole.id ? { ...r, permissionKeys: draftKeys } : r)),
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save permission changes");
    } finally {
      setSaving(false);
    }
  }

  function cancelChanges() {
    if (!selectedRole) return;
    setDraftKeys(selectedRole.permissionKeys);
    setSaveError(null);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRole(deleteTarget.id);
      setRoles((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      if (selectedRoleId === deleteTarget.id) {
        setSelectedRoleId(sortRolesForSidebar(roles.filter((r) => r.id !== deleteTarget.id))[0]?.id ?? null);
      }
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete role");
    } finally {
      setDeleting(false);
    }
  }

  function confirmResetDefaults() {
    if (!resetTarget?.defaultPermissionKeys) return;
    setDraftKeys(resetTarget.defaultPermissionKeys);
    setResetTarget(null);
  }

  const visibleModules = useMemo(() => {
    return modules
      .map((mod) => ({
        module: mod,
        visiblePermissions: mod.permissions.filter(
          (perm) =>
            matchesSearch(perm, mod.moduleLabel, permQuery) &&
            matchesFilter(perm, draftSet.has(perm.key), permFilter),
        ),
      }))
      .filter((entry) => entry.visiblePermissions.length > 0);
  }, [modules, permQuery, permFilter, draftSet]);

  return (
    <div>
      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading ? (
        <p>Loading…</p>
      ) : view === "compare" ? (
        <CompareRolesView roles={compareRoles} modules={modules} onBack={() => setView("editor")} />
      ) : (
        <div className={css.editorLayout}>
          <RoleSidebar
            roles={sidebarRoles}
            selectedRoleId={selectedRoleId}
            totalPermissionCount={totalPermissionCount}
            roleStats={roleStats}
            query={sidebarQuery}
            onQueryChange={setSidebarQuery}
            onSelect={requestSelectRole}
            onNewRole={() => setCreateOpen(true)}
            onCompareRoles={requestCompareView}
          />

          <div className={css.editorMain}>
            {selectedRole ? (
              <>
                <RoleHeader
                  role={selectedRole}
                  summary={summary}
                  staffCount={selectedStats?.staffCount ?? selectedRole.assignedCount}
                  branchCount={selectedStats?.branchCount ?? 0}
                  dirty={dirty}
                  changedCount={changedCount}
                  saving={saving}
                  onAssignedStaff={() => setAssignedStaffRole(selectedRole)}
                  onDuplicate={() => setDuplicateSource(selectedRole)}
                  onResetDefaults={() => setResetTarget(selectedRole)}
                  onEditDetails={() => setEditDetailsRole(selectedRole)}
                  onDelete={() => {
                    setDeleteError(null);
                    setDeleteTarget(selectedRole);
                  }}
                  onCancel={cancelChanges}
                  onSave={() => void saveChanges()}
                />

                {saveError ? <Alert variant="error">{saveError}</Alert> : null}
                {depNotice ? (
                  <Alert variant="info">
                    <strong>{depNotice.sourceLabel}</strong>{" "}
                    {depNotice.kind === "added" ? "enabled." : "disabled."}
                    <br />
                    {depNotice.affected.length} required permission{depNotice.affected.length === 1 ? "" : "s"}{" "}
                    {depNotice.kind === "added" ? "were also enabled" : "were also disabled"}:
                    <ul className={css.depNoticeList}>
                      {depNotice.affected.map((label) => (
                        <li key={label}>{label}</li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}

                {!selectedRole.isLocked ? (
                  <>
                    <PermissionToolbar
                      query={permQuery}
                      onQueryChange={setPermQuery}
                      filter={permFilter}
                      onFilterChange={setPermFilter}
                    />
                    <div className={css.permGroups}>
                      {visibleModules.map(({ module: mod, visiblePermissions }, i) => (
                        <PermissionGroup
                          key={mod.module}
                          module={mod}
                          visiblePermissions={visiblePermissions}
                          grantedKeys={draftSet}
                          expanded={expandedModules.has(mod.module) || !!permQuery.trim()}
                          isFirst={i === 0}
                          onToggleExpanded={() =>
                            setExpandedModules((prev) => {
                              const next = new Set(prev);
                              if (next.has(mod.module)) next.delete(mod.module);
                              else next.add(mod.module);
                              return next;
                            })
                          }
                          onTogglePermission={togglePermission}
                          onSelectAll={selectAllInGroup}
                        />
                      ))}
                      {visibleModules.length === 0 ? (
                        <p className={css.sidebarEmpty}>No permissions match this search/filter.</p>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <p className={css.sidebarEmpty}>Select a role to view its permissions.</p>
            )}
          </div>
        </div>
      )}

      <CreateRoleModal
        open={createOpen || !!duplicateSource}
        roles={sidebarRoles}
        initialName={duplicateSource ? `${duplicateSource.name} copy` : ""}
        initialCopyFromId={duplicateSource?.id ?? ""}
        onClose={() => {
          setCreateOpen(false);
          setDuplicateSource(null);
        }}
        onCreated={(role) => {
          setRoles((prev) => [...prev, role]);
          setSelectedRoleId(role.id);
          setView("editor");
        }}
      />

      <EditRoleDetailsModal
        open={!!editDetailsRole}
        role={editDetailsRole}
        onClose={() => setEditDetailsRole(null)}
        onUpdated={(roleId, patch) => {
          setRoles((prev) => prev.map((r) => (r.id === roleId ? { ...r, ...patch } : r)));
          setEditDetailsRole(null);
        }}
      />

      <AssignedStaffDrawer
        open={!!assignedStaffRole}
        role={assignedStaffRole}
        users={users}
        branches={branches}
        onClose={() => setAssignedStaffRole(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this role?"
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void confirmDelete()}
      >
        {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}
        <p>
          Delete <strong>{deleteTarget?.name}</strong>? This can&apos;t be undone.
          {deleteTarget && deleteTarget.assignedCount > 0
            ? " Reassign every staff member off this role first."
            : ""}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={resetTarget !== null}
        title="Reset to recommended defaults?"
        confirmLabel="Reset"
        variant="primary"
        onCancel={() => setResetTarget(null)}
        onConfirm={confirmResetDefaults}
      >
        <p>
          Replace <strong>{resetTarget?.name}</strong>&apos;s permissions with PharmaCeylon&apos;s
          recommended defaults for this role? Review and hit Save to apply.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={disableConfirm !== null}
        title="Disable this permission?"
        confirmLabel="Disable"
        onCancel={() => setDisableConfirm(null)}
        onConfirm={confirmCascadeDisable}
      >
        <p>
          <strong>{disableConfirm?.permLabel}</strong> is required by{" "}
          {disableConfirm?.dependents.length === 1 ? "another granted permission" : "other granted permissions"}.
          Disabling it will also disable:
        </p>
        <ul className={css.depNoticeList}>
          {disableConfirm?.dependents.map((label) => <li key={label}>{label}</li>)}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingNav !== null}
        title="Discard unsaved permission changes?"
        confirmLabel="Discard changes"
        onCancel={() => setPendingNav(null)}
        onConfirm={resolvePendingNav}
      >
        <p>
          You have unsaved changes to <strong>{selectedRole?.name}</strong>&apos;s permissions. Switching
          now will discard them.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** Natural hierarchy for the sidebar/pickers — owner leads, matching how staff actually rank. */
function sortRolesForSidebar(roles: RoleRow[]): RoleRow[] {
  const ORDER = ["owner", "manager", "pharmacist", "cashier", "inventory_clerk"];
  function rank(role: RoleRow): number {
    if (role.isSystem) {
      const idx = ORDER.indexOf(role.key);
      return idx === -1 ? 50 : idx;
    }
    return 60;
  }
  return [...roles].sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}

/** Compare view keeps owner last — it's fully locked, so it's the least interesting column to scan first. */
function sortRolesForCompare(roles: RoleRow[]): RoleRow[] {
  const BUILT_IN_ORDER = ["manager", "pharmacist", "cashier", "inventory_clerk"];
  function rank(role: RoleRow): number {
    if (role.key === "owner") return 100;
    if (role.isSystem) {
      const idx = BUILT_IN_ORDER.indexOf(role.key);
      return idx === -1 ? 50 : idx;
    }
    return 60;
  }
  return [...roles].sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}
