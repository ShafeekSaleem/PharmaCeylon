"use client";

import { StatusBadge } from "@/components/ui";
import type { PermissionDef } from "../types";
import css from "../roles.module.css";

type Props = {
  permission: PermissionDef;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
};

export function PermissionRow({ permission, checked, disabled, onToggle }: Props) {
  return (
    <label
      className={`${css.permRow2}${disabled ? ` ${css.permRow2Locked}` : ""}`}
      data-tooltip={disabled ? "Owner permissions can't be changed" : undefined}
    >
      <input
        type="checkbox"
        className={css.permCheckbox}
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <span className={css.permRow2Text}>
        <span className={css.permRow2Label}>
          {permission.label}
          {permission.riskLevel ? (
            <StatusBadge
              status={permission.riskLevel}
              variant={permission.riskLevel === "sensitive" ? "danger" : "warning"}
              label={permission.riskLevel === "sensitive" ? "Sensitive" : "Elevated"}
              className={css.riskBadge}
            />
          ) : null}
        </span>
        {permission.description ? (
          <span className={css.permRow2Desc}>{permission.description}</span>
        ) : null}
      </span>
    </label>
  );
}
