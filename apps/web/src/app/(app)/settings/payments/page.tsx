"use client";

import { PageHeader } from "@/components/ui";
import css from "../settings.module.css";
import { PaymentsCard } from "./payments-card";

export default function PaymentsSettingsPage() {
  return (
    <div>
      <PageHeader
        title="Payments"
        description="Payment methods at this branch's counters, and the card merchants offline references are checked against."
      />
      <div className={css.panel}>
        <PaymentsCard />
      </div>
    </div>
  );
}
