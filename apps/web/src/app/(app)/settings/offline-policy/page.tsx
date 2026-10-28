"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui";
import css from "../settings.module.css";
import { OfflineManagersCard } from "./offline-managers-card";
import { OfflinePolicyCard } from "./offline-policy-card";

export default function OfflinePolicySettingsPage() {
  // Bumped after the policy saves, so the managers card re-reads the branch's offline state.
  const [saves, setSaves] = useState(0);
  return (
    <div>
      <PageHeader
        title="Offline policy"
        description="Whether a prepared counter may sell through an internet outage, and the rules it follows."
      />
      <div className={css.panel}>
        <OfflinePolicyCard onSaved={() => setSaves((n) => n + 1)} />
        <OfflineManagersCard refreshKey={saves} />
      </div>
    </div>
  );
}
