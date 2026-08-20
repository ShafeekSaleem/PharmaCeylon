"use client";

import { IconLock, IconSearch, IconUserPlus } from "@/components/icons";
import type { RoleRow } from "../types";
import css from "../roles.module.css";

type RoleStat = { staffCount: number };

type Props = {
  roles: RoleRow[];
  selectedRoleId: string | null;
  totalPermissionCount: number;
  roleStats: Map<string, RoleStat>;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (roleId: string) => void;
  onNewRole: () => void;
  onCompareRoles: () => void;
};

export function RoleSidebar({
  roles,
  selectedRoleId,
  totalPermissionCount,
  roleStats,
  query,
  onQueryChange,
  onSelect,
  onNewRole,
  onCompareRoles,
}: Props) {
  const q = query.trim().toLowerCase();
  const filtered = q ? roles.filter((r) => r.name.toLowerCase().includes(q)) : roles;
  const builtIn = filtered.filter((r) => r.isSystem);
  const custom = filtered.filter((r) => !r.isSystem);

  function renderRole(role: RoleRow) {
    const stat = roleStats.get(role.id);
    const active = role.id === selectedRoleId;
    return (
      <button
        key={role.id}
        type="button"
        className={`${css.roleItem}${active ? ` ${css.roleItemActive}` : ""}`}
        onClick={() => onSelect(role.id)}
      >
        <span className={css.roleItemTop}>
          <span className={css.roleItemName}>{role.name}</span>
          <span className={css.roleItemBadge}>
            {role.isLocked ? (
              <>
                <IconLock size={10} /> Locked
              </>
            ) : role.isSystem ? (
              "Built-in"
            ) : (
              "Custom"
            )}
          </span>
        </span>
        <span className={css.roleItemMeta}>
          {role.isLocked
            ? "Full access"
            : `${role.permissionKeys.length} / ${totalPermissionCount} permissions · ${
                stat?.staffCount ?? role.assignedCount
              } staff`}
        </span>
      </button>
    );
  }

  return (
    <div className={css.sidebar}>
      <div className={css.sidebarSearchWrap}>
        <IconSearch size={13} className={css.sidebarSearchIcon} />
        <input
          type="search"
          className={css.sidebarSearchInput}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search roles…"
          aria-label="Search roles"
        />
      </div>

      <div className={css.sidebarList}>
        {builtIn.length ? <div className={css.sidebarGroup}>{builtIn.map(renderRole)}</div> : null}

        {custom.length ? (
          <>
            <div className={css.sidebarGroupLabel}>Custom</div>
            <div className={css.sidebarGroup}>{custom.map(renderRole)}</div>
          </>
        ) : null}

        {filtered.length === 0 ? <p className={css.sidebarEmpty}>No roles match “{query.trim()}”.</p> : null}
      </div>

      <div className={css.sidebarFooter}>
        <button type="button" className={css.sidebarNewRoleBtn} onClick={onNewRole}>
          <IconUserPlus size={14} /> New role
        </button>
        <button type="button" className={css.sidebarCompareBtn} onClick={onCompareRoles}>
          Compare roles
        </button>
      </div>
    </div>
  );
}
