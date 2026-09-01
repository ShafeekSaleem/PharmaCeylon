"use client";

import { IconAlertTriangle, IconInfo } from "@/components/icons";
import { ActionsPanel, type ActionPanelItem } from "@/app/(app)/reports/components/actions-panel";
import css from "../dashboard.module.css";

const ITEMS: ActionPanelItem[] = [
  {
    key: "amox-warfarin",
    icon: <IconAlertTriangle size={14} strokeWidth={1.75} />,
    tone: "danger",
    title: "Amoxicillin + Warfarin",
    description: "Bleeding risk increased — sample interaction.",
    countText: "High",
  },
  {
    key: "allergy-flag",
    icon: <IconAlertTriangle size={14} strokeWidth={1.75} />,
    tone: "warning",
    title: "Allergy flag",
    description: "Patient allergy matching not wired.",
    countText: "Medium",
  },
  {
    key: "duplicate-therapy",
    icon: <IconInfo size={14} strokeWidth={1.75} />,
    tone: "muted",
    title: "Duplicate therapy",
    description: "Screening pipeline not connected yet.",
    countText: "Low",
  },
];

export function PharmacistDrugInteractionWidget() {
  return (
    <ActionsPanel
      title="Drug Interaction / CDS"
      items={ITEMS}
      variant="cards"
      headerExtra={
        <>
          <span className={css.placeholderBadge}>Sample</span>
          <span className={css.muted}>Not connected</span>
        </>
      }
    />
  );
}
