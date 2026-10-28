"use client";

import { PageHeader } from "@/components/ui";
import css from "../settings.module.css";
import { OfflineManagersCard } from "./offline-managers-card";
import { OfflinePolicyCard } from "./offline-policy-card";

export default function OfflinePolicySettingsPage() {
  return (
    <div>
      <PageHeader
        title="Offline policy"
        description="Whether a prepared counter may sell through an internet outage, and the rules it follows."
      />
      <div className={css.panel}>
        <OfflinePolicyCard />
        <OfflineManagersCard />
      </div>
    </div>
  );
}
