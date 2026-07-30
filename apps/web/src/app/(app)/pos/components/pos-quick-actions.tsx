"use client";

import {
  IconArchive,
  IconBarcodeScan,
  IconEdit,
  IconReceipt,
  IconTag,
  IconUser,
} from "@/components/icons";
import css from "../pos.module.css";

type Props = {
  onScan: () => void;
  onPriceCheck: () => void;
  onOpenDrawer: () => void;
  onCustomerLookup: () => void;
  onLastReceipt: () => void;
  onManualItem: () => void;
  hasLastReceipt: boolean;
};

export function PosQuickActions({
  onScan,
  onPriceCheck,
  onOpenDrawer,
  onCustomerLookup,
  onLastReceipt,
  onManualItem,
  hasLastReceipt,
}: Props) {
  const actions = [
    { label: "Scan barcode", icon: <IconBarcodeScan size={14} />, onClick: onScan, tip: "/" },
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
      label: "Customer lookup",
      icon: <IconUser size={14} />,
      onClick: onCustomerLookup,
      tip: "Alt + C",
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
            disabled={action.disabled}
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
