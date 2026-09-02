"use client";

import { useMemo } from "react";
import type { ComponentType } from "react";
import {
  IconBarChart,
  IconClipboardList,
  IconGrid,
  IconPackage,
  IconPill,
  IconPlus,
  IconShoppingCart,
  IconSparkles,
  IconStethoscope,
  IconTruck,
  type IconProps,
} from "@/components/icons";
import { Modal } from "@/components/ui";
import type { WidgetDef } from "../widgets/types";
import css from "../dashboard.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  catalog: WidgetDef[];
  activeKeys: Set<string>;
  onAdd: (key: string) => void;
};

/** Purely decorative: a category → {icon, color} lookup so the Add Widget
 * list reads at a glance instead of as an undifferentiated bullet list.
 * Falls back to a generic grid icon in the primary color for any category
 * not listed here, so a new category never breaks the drawer. */
const CATEGORY_META: Record<string, { icon: ComponentType<IconProps>; color: string }> = {
  Overview: { icon: IconBarChart, color: "var(--pc-primary)" },
  Purchasing: { icon: IconTruck, color: "var(--pc-alert-info-icon)" },
  Operations: { icon: IconClipboardList, color: "var(--pc-alert-info-icon)" },
  Inventory: { icon: IconPackage, color: "var(--pc-alert-warning-icon)" },
  Sales: { icon: IconShoppingCart, color: "var(--pc-alert-success-icon)" },
  Dispensing: { icon: IconPill, color: "var(--pc-primary)" },
  Clinical: { icon: IconStethoscope, color: "var(--pc-alert-error-icon)" },
  Insights: { icon: IconSparkles, color: "#7c3aed" },
};
const DEFAULT_CATEGORY_META = { icon: IconGrid, color: "var(--pc-primary)" };

export function AddWidgetDrawer({ open, onClose, catalog, activeKeys, onAdd }: Props) {
  const groups = useMemo(() => {
    const byCategory = new Map<string, WidgetDef[]>();
    for (const def of catalog) {
      if (activeKeys.has(def.key)) continue;
      const list = byCategory.get(def.category) ?? [];
      list.push(def);
      byCategory.set(def.category, list);
    }
    return [...byCategory.entries()];
  }, [catalog, activeKeys]);

  return (
    <Modal open={open} onClose={onClose} title="Add widget" description="Pick a widget to add to your dashboard." size="md">
      {groups.length === 0 ? (
        <p className={css.emptyState}>Every available widget is already on your dashboard.</p>
      ) : (
        <div className={css.addWidgetGroups}>
          {groups.map(([category, defs]) => (
            <div key={category} className={css.addWidgetGroup}>
              <h3 className={css.addWidgetGroupTitle}>{category}</h3>
              <ul className={css.addWidgetList}>
                {defs.map((def) => {
                  const meta = CATEGORY_META[def.category] ?? DEFAULT_CATEGORY_META;
                  const Icon = meta.icon;
                  return (
                    <li key={def.key}>
                      <button type="button" className={css.addWidgetItem} onClick={() => onAdd(def.key)}>
                        <span className={css.addWidgetItemLead}>
                          <span
                            className={css.addWidgetItemIcon}
                            style={{
                              color: meta.color,
                              background: `color-mix(in srgb, ${meta.color} 14%, var(--pc-card-bg))`,
                            }}
                            aria-hidden
                          >
                            <Icon size={15} strokeWidth={1.75} />
                          </span>
                          <span>{def.title}</span>
                        </span>
                        <span className={css.addWidgetItemAdd} aria-hidden>
                          <IconPlus size={14} strokeWidth={2} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
