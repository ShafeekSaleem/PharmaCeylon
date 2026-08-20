"use client";

import { useEffect, useRef, useState } from "react";
import { IconMoreVertical } from "@/components/icons";
import css from "../roles.module.css";

export type RoleMenuAction = {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger" | "default";
};

type Props = {
  actions: RoleMenuAction[];
};

export function RoleActionsMenu({ actions }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visible = actions.filter((action) => !action.disabled);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (visible.length === 0) return null;

  return (
    <div ref={ref} className={css.menuWrap}>
      <button
        type="button"
        className={css.menuTrigger}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More role actions"
      >
        <IconMoreVertical size={16} />
      </button>
      {open ? (
        <div className={css.menuPanel} role="menu">
          {visible.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={`${css.menuItem}${action.tone === "danger" ? ` ${css.menuItemDanger}` : ""}`}
              onClick={() => {
                setOpen(false);
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
