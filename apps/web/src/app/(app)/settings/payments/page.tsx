"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui";
import css from "../settings.module.css";
import { DefaultPaymentCard } from "./default-payment-card";
import { PaymentsCard } from "./payments-card";

export default function PaymentsSettingsPage() {
  // Bumped when the default saves, so the branch card's "start on cash instead" note re-reads it.
  const [saves, setSaves] = useState(0);
  return (
    <div>
      <PageHeader
        title="Payments"
        description="How customers can pay at the counters, and the card merchants offline references are checked against."
      />
      <div className={css.panel}>
        <DefaultPaymentCard onSaved={() => setSaves((n) => n + 1)} />
        <PaymentsCard refreshKey={saves} />
      </div>
    </div>
  );
}
