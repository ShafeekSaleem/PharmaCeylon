"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui";
import { formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import { rowLinkProps } from "../lib/row-link";
import css from "../dashboard.module.css";

const HOLDS_PAGE_SIZE = 4;

const AVATAR_TONE_CLASS = [
  css.avatarTone_0,
  css.avatarTone_1,
  css.avatarTone_2,
  css.avatarTone_3,
  css.avatarTone_4,
  css.avatarTone_5,
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function avatarToneClass(name: string): string {
  const n = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return AVATAR_TONE_CLASS[n % AVATAR_TONE_CLASS.length]!;
}

function waitMinutes(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

type QueueBucket = "urgent" | "awaiting" | "ready";

function queueBucket(minutes: number): QueueBucket {
  if (minutes > 30) return "urgent";
  if (minutes >= 10) return "awaiting";
  return "ready";
}

const QUEUE_BUCKET_LABEL: Record<QueueBucket, string> = {
  urgent: "Urgent",
  awaiting: "Awaiting Rx",
  ready: "Ready",
};

const QUEUE_BUCKET_VARIANT: Record<QueueBucket, "danger" | "info" | "success"> = {
  urgent: "danger",
  awaiting: "info",
  ready: "success",
};

export function PharmacistPrescriptionQueueWidget({ data }: { data: DashboardData }) {
  const router = useRouter();
  const { pharmacistHolds } = data;

  const queueRows = useMemo(
    () =>
      [...pharmacistHolds]
        .map((h) => ({ ...h, bucket: queueBucket(waitMinutes(h.createdAt)) }))
        .sort((a, b) => waitMinutes(b.createdAt) - waitMinutes(a.createdAt)),
    [pharmacistHolds],
  );

  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(queueRows.length / HOLDS_PAGE_SIZE));

  return (
    <DashboardPanel
      title="Prescription Verification Queue"
      footerHref="/pos"
      footerLabel="Open POS holds →"
      footerMeta={`${pharmacistHolds.length} waiting`}
    >
      {pharmacistHolds.length === 0 ? (
        <p className={css.emptyState}>No POS holds currently flagged for pharmacist review.</p>
      ) : (
        <>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Hold / label</th>
                <th>Ref</th>
                <th>Items</th>
                <th>Total</th>
                <th>Held by</th>
                <th>Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {paginate(queueRows, page, HOLDS_PAGE_SIZE).map((h) => {
                const name = h.label || h.heldByName;
                return (
                  <tr key={h.id} {...rowLinkProps(router, `/pos?panel=holds&holdId=${h.id}`)}>
                    <td>
                      <span className={css.avatarRow}>
                        <span className={`${css.avatarChip} ${avatarToneClass(name)}`}>{initials(name)}</span>
                        {name}
                      </span>
                    </td>
                    <td>
                      <span className={css.invoiceLink}>{h.holdRef}</span>
                    </td>
                    <td>{h.itemCount}</td>
                    <td className={css.teamNum}>{formatMoney(h.total)}</td>
                    <td className={css.muted}>{h.heldByName}</td>
                    <td className={css.muted}>{formatRelativeTime(h.createdAt)}</td>
                    <td>
                      <StatusBadge
                        status="pending"
                        label={QUEUE_BUCKET_LABEL[h.bucket]}
                        variant={QUEUE_BUCKET_VARIANT[h.bucket]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * HOLDS_PAGE_SIZE + 1}–${Math.min(queueRows.length, (page + 1) * HOLDS_PAGE_SIZE)} of ${queueRows.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
