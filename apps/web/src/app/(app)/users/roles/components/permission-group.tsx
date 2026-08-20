"use client";

import { useEffect, useRef } from "react";
import { IconChevronDown, IconChevronRight } from "@/components/icons";
import type { PermissionDef, PermissionModule } from "../types";
import { PermissionRow } from "./permission-row";
import css from "../roles.module.css";

type Props = {
  module: PermissionModule;
  /** Search/filter-narrowed subset actually rendered as rows — header counts still reflect the full module. */
  visiblePermissions: PermissionDef[];
  grantedKeys: Set<string>;
  expanded: boolean;
  disabled?: boolean;
  isFirst?: boolean;
  onToggleExpanded: () => void;
  onTogglePermission: (key: string) => void;
  onSelectAll: (keys: string[], grant: boolean) => void;
};

export function PermissionGroup({
  module,
  visiblePermissions,
  grantedKeys,
  expanded,
  disabled,
  isFirst,
  onToggleExpanded,
  onTogglePermission,
  onSelectAll,
}: Props) {
  const selectAllRef = useRef<HTMLInputElement>(null);
  const keys = module.permissions.map((p) => p.key);
  const grantedCount = keys.filter((k) => grantedKeys.has(k)).length;
  const allGranted = grantedCount === keys.length && keys.length > 0;
  const someGranted = grantedCount > 0 && !allGranted;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someGranted;
  }, [someGranted]);

  return (
    <section className={`${css.permGroup}${isFirst ? "" : ` ${css.permGroupDivider}`}`}>
      <div className={css.permGroupHead}>
        {!disabled ? (
          <input
            ref={selectAllRef}
            type="checkbox"
            className={css.permCheckbox}
            checked={allGranted}
            onChange={() => onSelectAll(keys, !allGranted)}
            aria-label={`Select all in ${module.moduleLabel}`}
          />
        ) : null}
        <button
          type="button"
          className={css.permGroupToggle}
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <span className={css.permGroupTitle}>{module.moduleLabel}</span>
        </button>
        <span className={css.permGroupCount}>
          {grantedCount} / {keys.length}
        </span>
      </div>
      {expanded ? (
        <div className={css.permGroupBody}>
          {visiblePermissions.map((perm) => (
            <PermissionRow
              key={perm.key}
              permission={perm}
              checked={grantedKeys.has(perm.key)}
              disabled={disabled}
              onToggle={() => onTogglePermission(perm.key)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
