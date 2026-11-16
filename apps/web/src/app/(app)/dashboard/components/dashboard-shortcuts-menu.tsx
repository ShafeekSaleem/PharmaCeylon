"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconPlus } from "@/components/icons";
import { RoleLink } from "@/components/role-access";
import type { QuickAction } from "./quick-actions-bar";
import { isPosHref, usePosHidden } from "../lib/pos-links";
import css from "../dashboard.module.css";

const TONE_CLASS = {
  primary: css.shortcutsMenuIcon_primary,
  success: css.shortcutsMenuIcon_success,
  warning: css.shortcutsMenuIcon_warning,
  danger: css.shortcutsMenuIcon_danger,
  info: css.shortcutsMenuIcon_info,
} as const;

type Props = {
  actions: QuickAction[];
};

export function DashboardShortcutsMenu({ actions: requested }: Props) {
  const posHidden = usePosHidden();
  const actions = requested.filter(
    (action) => !(posHidden && isPosHref(action.href)),
  );
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!actions.length) return null;

  return (
    <div className={css.shortcutsMenuWrap} ref={wrapRef}>
      <button
        type="button"
        className={css.customizeBtn}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <IconPlus size={13} strokeWidth={1.75} aria-hidden />
        Shortcuts
      </button>
      {open ? (
        <div
          id={menuId}
          className={css.shortcutsMenuPanel}
          role="menu"
          aria-label="Dashboard shortcuts"
        >
          {actions.map((action) => {
            const tone = action.tone ?? "primary";
            const iconCls = `${css.shortcutsMenuIcon} ${TONE_CLASS[tone]}`;
            return (
              <RoleLink
                key={action.href + action.label}
                href={action.href}
                roles={action.roles}
                className={css.shortcutsMenuItem}
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                <span className={iconCls}>{action.icon}</span>
                <span>{action.label}</span>
              </RoleLink>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}