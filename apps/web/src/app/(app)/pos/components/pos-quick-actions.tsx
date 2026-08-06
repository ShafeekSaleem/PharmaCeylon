"use client";

import { IconArchive, IconEdit, IconLock, IconReceipt, IconTag } from "@/components/icons";
import css from "../pos.module.css";

type Props = {
  onPriceCheck: () => void;
  onOpenDrawer: () => void;
  onLastReceipt: () => void;
  onManualItem: () => void;
  hasLastReceipt: boolean;
  canSetPosPin?: boolean;
  onSetPosPin?: () => void;
};

export function PosQuickActions({
  onPriceCheck,
  onOpenDrawer,
  onLastReceipt,
  onManualItem,
  hasLastReceipt,
  canSetPosPin = false,
  onSetPosPin,
}: Props) {
  const actions = [
    {
      label: "Price check",
      icon: <IconTag size={14} />,
      onClick: onPriceCheck,
      tip: "F3 — look up a price without touching the cart",
    },
    {
      label: "Open drawer",
      icon: <IconArchive size={14} />,
      onClick: onOpenDrawer,
      tip: "Pop the cash drawer",
    },
    {
      label: "Last receipt",
      icon: <IconReceipt size={14} />,
      onClick: onLastReceipt,
      tip: hasLastReceipt ? "Reopen the last receipt" : "No receipt in this session yet",
      disabled: !hasLastReceipt,
    },
    {
      label: "Manual item",
      icon: <IconEdit size={14} />,
      onClick: onManualItem,
      tip: "Add a line with an overridden price",
    },
    ...(canSetPosPin && onSetPosPin
      ? [
          {
            label: "Till PIN",
            icon: <IconLock size={14} />,
            onClick: onSetPosPin,
            tip: "Set your short pharmacist till PIN for cashier co-sign",
          },
        ]
      : []),
  ];

  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Quick Actions</h2>
      <div className={css.quickActionGrid}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={css.quickActionBtn}
            onClick={action.onClick}
            disabled={"disabled" in action ? Boolean(action.disabled) : false}
            data-tooltip={action.tip}
          >
            <span className={css.quickActionIcon}>{action.icon}</span>
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
