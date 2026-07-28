"use client";

import { useEffect, useRef, useState } from "react";
import scss from "../stocktakes.module.css";

export type StocktakeMenuAction = {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger" | "default";
};

type Props = {
  actions: StocktakeMenuAction[];
  disabled?: boolean;
};

export function StocktakeActionsMenu({ actions, disabled }: Props) {
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
    <div ref={ref} className={scss.menuWrap}>
      <button
        type="button"
        className={scss.menuTrigger}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        More actions
      </button>
      {open ? (
        <div className={scss.menuPanel} role="menu">
          {visible.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={`${scss.menuItem}${action.tone === "danger" ? ` ${scss.menuItemDanger}` : ""}`}
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
