"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IconMoreVertical } from "@/components/icons";
import css from "../reports.module.css";

export type RowAction = { label: string; href?: string; onClick?: () => void };

export function RowActionMenu({ actions }: { actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div className={css.kebabWrap} ref={ref}>
      <button type="button" className={css.kebabBtn} onClick={() => setOpen((v) => !v)} aria-label="Row actions" aria-haspopup="menu" aria-expanded={open}>
        <IconMoreVertical size={15} />
      </button>
      {open ? (
        <div className={css.kebabMenu} role="menu">
          {actions.map((a) =>
            a.href ? (
              <Link key={a.label} href={a.href} role="menuitem" onClick={() => setOpen(false)}>
                {a.label}
              </Link>
            ) : (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  a.onClick?.();
                  setOpen(false);
                }}
              >
                {a.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
