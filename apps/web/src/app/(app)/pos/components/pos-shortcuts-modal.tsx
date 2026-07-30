"use client";

import { useMemo } from "react";
import { Modal } from "@/components/ui";
import { SHORTCUTS } from "../constants";
import css from "../pos.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function PosShortcutsModal({ open, onClose }: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof SHORTCUTS>();
    for (const shortcut of SHORTCUTS) {
      const list = map.get(shortcut.group) ?? [];
      list.push(shortcut);
      map.set(shortcut.group, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Built for a scanner in one hand and a keyboard in the other."
      size="lg"
    >
      <div className={css.shortcutGroups}>
        {groups.map(([group, rows]) => (
          <div key={group}>
            <h3 className={css.shortcutGroupTitle}>{group}</h3>
            {rows.map((row) => (
              <div key={row.keys} className={css.shortcutRow}>
                <span className={css.shortcutAction}>{row.action}</span>
                <span className={css.kbd}>{row.keys}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
