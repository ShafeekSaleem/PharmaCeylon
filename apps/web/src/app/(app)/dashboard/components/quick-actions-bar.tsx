"use client";

import type { ReactNode } from "react";
import { RoleLink } from "@/components/role-access";
import type { RoleName } from "@/lib/role-access";
import css from "../dashboard.module.css";

export type QuickActionTone =
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";

export type QuickAction = {
  href: string;
  label: string;
  icon: ReactNode;
  roles?: RoleName[];
  /** Theme tone for the icon chip (defaults to primary). */
  tone?: QuickActionTone;
  /** Placeholder action — no live module; render Sample and skip navigation. */
  sample?: boolean;
};

type Props = {
  title?: string;
  actions: QuickAction[];
};

const TONE_CLASS: Record<QuickActionTone, string> = {
  primary: css.quickBarIcon_primary,
  success: css.quickBarIcon_success,
  warning: css.quickBarIcon_warning,
  danger: css.quickBarIcon_danger,
  info: css.quickBarIcon_info,
};

export function QuickActionsBar({ title = "Quick actions", actions }: Props) {
  return (
    <section className={css.quickBar}>
      <h2 className={css.panelTitle}>{title}</h2>
      <div className={css.quickBarGrid}>
        {actions.map((action) => {
          const tone = action.tone ?? "primary";
          const iconCls = `${css.quickBarIcon} ${TONE_CLASS[tone]}`;
          const itemCls = `${css.quickBarItem} ${css[`quickBarItem_${tone}`] ?? ""}`;

          if (action.sample) {
            return (
              <span
                key={action.href + action.label}
                className={`${itemCls} ${css.quickBarItemSample}`}
                title="Coming soon"
                aria-disabled="true"
              >
                <span className={iconCls}>{action.icon}</span>
                <span>{action.label}</span>
                <span className={css.placeholderBadge}>Sample</span>
              </span>
            );
          }

          return (
            <RoleLink
              key={action.href + action.label}
              href={action.href}
              roles={action.roles}
              className={itemCls}
            >
              <span className={iconCls}>{action.icon}</span>
              <span>{action.label}</span>
            </RoleLink>
          );
        })}
      </div>
    </section>
  );
}
