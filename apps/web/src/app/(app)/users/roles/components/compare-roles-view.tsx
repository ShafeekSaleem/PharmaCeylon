"use client";

import { useMemo, useState } from "react";
import { Fragment } from "react";
import { IconCheck, IconChevronLeft, IconLock, IconMinus, IconSearch } from "@/components/icons";
import { matchesSearch } from "../permission-utils";
import type { PermissionModule, RoleRow } from "../types";
import css from "../roles.module.css";

type Props = {
  roles: RoleRow[];
  modules: PermissionModule[];
  onBack: () => void;
};

const MAX_DEFAULT_SELECTED = 5;

export function CompareRolesView({ roles, modules, onBack }: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(roles.slice(0, MAX_DEFAULT_SELECTED).map((r) => r.id)),
  );
  const [diffOnly, setDiffOnly] = useState(false);
  const [query, setQuery] = useState("");

  const compareRoles = roles.filter((r) => selected.has(r.id));

  function toggleRole(roleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  const rows = useMemo(() => {
    const out: { module: PermissionModule; permission: PermissionModule["permissions"][number] }[] = [];
    for (const mod of modules) {
      const perms = mod.permissions.filter((perm) => matchesSearch(perm, mod.moduleLabel, query));
      for (const perm of perms) {
        const values = compareRoles.map((role) => role.permissionKeys.includes(perm.key));
        const allSame = values.every((v) => v === values[0]);
        if (diffOnly && allSame && compareRoles.length > 1) continue;
        out.push({ module: mod, permission: perm });
      }
    }
    return out;
  }, [modules, query, compareRoles, diffOnly]);

  return (
    <div className={css.compareView}>
      <div className={css.compareHeader}>
        <button type="button" className={css.compareBackBtn} onClick={onBack}>
          <IconChevronLeft size={14} /> Back to role editor
        </button>
        <h2 className={css.compareTitle}>Compare roles</h2>
      </div>

      <div className={css.comparePickerRow}>
        {roles.map((role) => (
          <button
            key={role.id}
            type="button"
            className={`${css.comparePickerChip}${selected.has(role.id) ? ` ${css.comparePickerChipActive}` : ""}`}
            onClick={() => toggleRole(role.id)}
          >
            {selected.has(role.id) ? <IconCheck size={11} /> : null}
            {role.name}
          </button>
        ))}
      </div>

      <div className={css.compareToolsRow}>
        <div className={css.compareSearchWrap}>
          <IconSearch size={14} className={css.compareSearchIcon} />
          <input
            type="search"
            className={css.compareSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search permissions…"
            aria-label="Search permissions"
          />
        </div>
        <label className={css.compareDiffToggle}>
          <input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} />
          Show differences only
        </label>
      </div>

      {compareRoles.length === 0 ? (
        <p className={css.sidebarEmpty}>Select at least one role to compare.</p>
      ) : (
        <div className={css.matrixWrap}>
          <table className={css.matrix}>
            <thead>
              <tr>
                <th>Permission</th>
                {compareRoles.map((role) => (
                  <th key={role.id} className={role.isLocked ? css.lockedCol : undefined}>
                    <span className={css.roleColName}>
                      {role.isLocked ? <IconLock size={11} /> : null}
                      {role.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={compareRoles.length + 1} className={css.compareEmptyCell}>
                    No permissions match this search/filter.
                  </td>
                </tr>
              ) : (
                rows.map(({ module: mod, permission: perm }, i) => {
                  const showModuleHeader = i === 0 || rows[i - 1].module.module !== mod.module;
                  return (
                    <Fragment key={perm.key}>
                      {showModuleHeader ? (
                        <tr className={css.moduleRow}>
                          <th colSpan={compareRoles.length + 1}>{mod.moduleLabel}</th>
                        </tr>
                      ) : null}
                      <tr className={css.permRow}>
                        <td className={css.permCell}>
                          <div className={css.permLabel}>{perm.label}</div>
                        </td>
                        {compareRoles.map((role) => (
                          <td
                            key={role.id}
                            className={`${css.toggleCell}${role.isLocked ? ` ${css.lockedCol}` : ""}`}
                          >
                            {role.permissionKeys.includes(perm.key) ? (
                              <IconCheck size={15} strokeWidth={3} className={css.compareYes} />
                            ) : (
                              <IconMinus size={12} className={css.compareNo} />
                            )}
                          </td>
                        ))}
                      </tr>
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
