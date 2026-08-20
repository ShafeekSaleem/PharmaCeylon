"use client";

import { IconLock } from "@/components/icons";
import { ModalButton } from "@/components/ui";
import type { RoleRow } from "../types";
import type { RiskSummary } from "../permission-utils";
import { RoleActionsMenu, type RoleMenuAction } from "./role-actions-menu";
import css from "../roles.module.css";

type Props = {
  role: RoleRow;
  summary: RiskSummary;
  staffCount: number;
  branchCount: number;
  dirty: boolean;
  changedCount: number;
  saving: boolean;
  onAssignedStaff: () => void;
  onDuplicate: () => void;
  onResetDefaults: () => void;
  onEditDetails: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onSave: () => void;
};

export function RoleHeader({
  role,
  summary,
  staffCount,
  branchCount,
  dirty,
  changedCount,
  saving,
  onAssignedStaff,
  onDuplicate,
  onResetDefaults,
  onEditDetails,
  onDelete,
  onCancel,
  onSave,
}: Props) {
  const menuActions: RoleMenuAction[] = role.isLocked
    ? []
    : role.isSystem
      ? [
          { id: "duplicate", label: "Duplicate role", onClick: onDuplicate },
          { id: "reset", label: "Reset to recommended defaults", onClick: onResetDefaults },
        ]
      : [
          { id: "duplicate", label: "Duplicate role", onClick: onDuplicate },
          { id: "edit", label: "Edit details", onClick: onEditDetails },
          { id: "delete", label: "Delete role", onClick: onDelete, tone: "danger" },
        ];

  return (
    <div className={css.roleHeader}>
      <div className={css.roleHeaderTop}>
        <div className={css.roleHeaderTitleRow}>
          <h2 className={css.roleHeaderName}>{role.name}</h2>
          <span className={css.roleHeaderBadge}>
            {role.isLocked ? (
              <>
                <IconLock size={11} /> Locked
              </>
            ) : role.isSystem ? (
              "Built-in"
            ) : (
              "Custom"
            )}
          </span>
        </div>
        <div className={css.roleHeaderActions}>
          <ModalButton variant="secondary" onClick={onAssignedStaff}>
            Assigned staff
          </ModalButton>
          {dirty ? (
            <ModalButton variant="secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </ModalButton>
          ) : null}
          {!role.isLocked ? (
            <ModalButton variant="primary" onClick={onSave} loading={saving} disabled={!dirty}>
              Save changes
            </ModalButton>
          ) : null}
          <RoleActionsMenu actions={menuActions} />
        </div>
      </div>

      {role.description ? <p className={css.roleHeaderDesc}>{role.description}</p> : null}

      <div className={css.roleHeaderSummary}>
        {role.isLocked ? (
          <span>Full access — every permission, on every branch.</span>
        ) : (
          <>
            <span>
              {staffCount} staff{branchCount > 0 ? ` · ${branchCount} branch${branchCount === 1 ? "" : "es"}` : ""}
            </span>
            <span className={css.roleHeaderSummarySep}>·</span>
            <span>
              {summary.totalGranted} / {summary.totalPermissions} permissions
            </span>
            {summary.elevatedGranted > 0 ? (
              <>
                <span className={css.roleHeaderSummarySep}>·</span>
                <span>{summary.elevatedGranted} elevated</span>
              </>
            ) : null}
            {summary.sensitiveGranted > 0 ? (
              <>
                <span className={css.roleHeaderSummarySep}>·</span>
                <span>{summary.sensitiveGranted} sensitive</span>
              </>
            ) : null}
          </>
        )}
      </div>

      {dirty ? <p className={css.unsavedNote}>{changedCount} unsaved change{changedCount === 1 ? "" : "s"}</p> : null}
    </div>
  );
}
