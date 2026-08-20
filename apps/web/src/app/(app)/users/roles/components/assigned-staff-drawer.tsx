"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import type { TenantBranch } from "@/lib/auth-client";
import type { AdminUser } from "../../types";
import type { RoleRow } from "../types";
import css from "../roles.module.css";

type Props = {
  open: boolean;
  role: RoleRow | null;
  users: AdminUser[];
  branches: TenantBranch[];
  onClose: () => void;
};

export function AssignedStaffDrawer({ open, role, users, branches, onClose }: Props) {
  const branchNameById = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);

  const rows = useMemo(() => {
    if (!role) return [];
    const out: { userId: string; fullName: string; email: string; branchId: string }[] = [];
    for (const user of users) {
      for (const mapping of user.userBranchRoles) {
        if (mapping.roleId === role.id) {
          out.push({ userId: user.id, fullName: user.fullName, email: user.email, branchId: mapping.branchId });
        }
      }
    }
    return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [role, users]);

  if (!role) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${role.name} — assigned staff`}
      description={`${rows.length} assignment${rows.length === 1 ? "" : "s"} across branches`}
      size="md"
      footer={
        <ModalFooter>
          <Link href="/users" className={css.assignedStaffManageLink}>
            Manage staff →
          </Link>
          <ModalButton variant="secondary" onClick={onClose}>
            Close
          </ModalButton>
        </ModalFooter>
      }
    >
      {rows.length === 0 ? (
        <p className={css.sidebarEmpty}>No staff currently have this role.</p>
      ) : (
        <div className={css.staffTableWrap}>
          <table className={css.staffTable}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Branch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.userId}:${row.branchId}`}>
                  <td>
                    <div className={css.staffTableName}>{row.fullName}</div>
                    <div className={css.staffTableEmail}>{row.email}</div>
                  </td>
                  <td>{branchNameById.get(row.branchId) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
