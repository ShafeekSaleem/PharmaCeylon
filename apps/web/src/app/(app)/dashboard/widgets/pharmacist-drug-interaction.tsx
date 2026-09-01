"use client";

import { StatusBadge } from "@/components/ui";
import { DashboardPanel } from "../components/dashboard-panel";
import css from "../dashboard.module.css";

export function PharmacistDrugInteractionWidget() {
  return (
    <DashboardPanel
      title="Drug Interaction / CDS"
      headerRight={<span className={css.placeholderBadge}>Sample</span>}
      footerLabel="Clinical screening coming soon"
      footerMeta="Not connected"
    >
      <ul className={css.aiList}>
        <li className={`${css.aiItem} ${css.aiTone_danger}`}>
          <div>
            <strong>Amoxicillin + Warfarin</strong>
            <p>Bleeding risk increased — sample interaction.</p>
          </div>
          <StatusBadge status="pending" label="High" variant="danger" />
        </li>
        <li className={`${css.aiItem} ${css.aiTone_warning}`}>
          <div>
            <strong>Allergy flag</strong>
            <p>Patient allergy matching not wired.</p>
          </div>
          <StatusBadge status="pending" label="Medium" variant="warning" />
        </li>
        <li className={`${css.aiItem} ${css.aiTone_info}`}>
          <div>
            <strong>Duplicate therapy</strong>
            <p>Screening pipeline not connected yet.</p>
          </div>
          <StatusBadge status="pending" label="Low" variant="success" />
        </li>
      </ul>
    </DashboardPanel>
  );
}
