"use client";

import { PageHeader } from "@/components/ui";
import css from "../settings.module.css";
import { ReceiptCard } from "./receipt-card";
import { RegisterNumberingCard } from "./register-numbering-card";

export default function ReceiptsSettingsPage() {
  return (
    <div>
      <PageHeader
        title="Receipts"
        description="What the printed receipt shows, and the number series each register issues."
      />
      <div className={css.panel}>
        <ReceiptCard />
        <RegisterNumberingCard />
      </div>
    </div>
  );
}
