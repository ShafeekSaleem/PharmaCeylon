"use client";

import { IconClipboardList } from "@/components/icons";
import css from "../reports.module.css";

export function ComingSoonPanel({ label }: { label: string }) {
  return (
    <div className={css.comingSoon}>
      <IconClipboardList size={22} />
      <h3>{label} is on the roadmap</h3>
      <p>
        This report isn&apos;t built yet — it&apos;s listed here so the Reports navigation already has a home
        for it once the underlying data is ready.
      </p>
    </div>
  );
}
