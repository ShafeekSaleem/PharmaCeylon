"use client";

import Link from "next/link";
import { IconHome } from "@/components/icons";
import { DashboardPanel } from "../components/dashboard-panel";
import { useDailyWork } from "../hooks/use-daily-work";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { dashboardHref, usePosHidden } from "../lib/pos-links";
import css from "../dashboard.module.css";

/** "As of 10:42", in the branch's business timezone: the moment the queue was read. */
export function asOfLabel(asOf: string, timezone: string): string {
  return `As of ${new Date(asOf).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone })}`;
}

/**
 * W9 #71: jobs waiting at this branch's counter — approved documents to post, deliveries to
 * receive, counts to enter. Fed by the daily-work API's `counter` filter, so a new approved
 * document type appears here as soon as the API registers it. Counter health (online, offline,
 * last sync) is not shown: P2/P5 don't report it yet.
 */
export function CounterWaitingWidget({ data }: { data: DashboardData }) {
  const work = useDailyWork(data.branchId, data.lastUpdatedAt, "counter");
  const posHidden = usePosHidden();
  const result = work.data;
  const waiting = result?.counts.counter ?? 0;

  return (
    <DashboardPanel
      title="Waiting at the counter"
      subtitle={result ? `${result.branchName} · done in PharmaCeylon POS` : "Done in PharmaCeylon POS"}
      icon={<IconHome size={15} />}
      compact
      footerMeta={result ? asOfLabel(result.asOf, result.timezone) : undefined}
    >
      {work.error ? (
        <p className={css.emptyState} role="alert">
          Couldn&apos;t load counter work. {work.error}
        </p>
      ) : work.loading && !result ? (
        <p className={css.emptyState} role="status">
          Loading…
        </p>
      ) : !result?.counterLive ? (
        <p className={css.emptyState}>
          This branch isn&apos;t live on PharmaCeylon POS yet, so approved work is still done on
          the web. It appears in today&apos;s priorities.
        </p>
      ) : waiting === 0 ? (
        <p className={css.emptyState}>Nothing is waiting at the counter.</p>
      ) : (
        <>
          <p className={css.muted} style={{ marginBottom: "0.5rem" }}>
            {waiting} {waiting === 1 ? "job waits" : "jobs wait"} for someone at the counter.
          </p>
          <ul className={css.pipelineList}>
            {result.items.map((item) => {
              const href = dashboardHref(item.href, posHidden);
              const body = (
                <span className={css.pipelineRowBody}>
                  <strong>{item.title}</strong>
                  <span className={css.muted}>
                    {item.reference} · {item.detail.replace(/_/g, " ")}
                  </span>
                </span>
              );
              return (
                <li key={item.id} data-kind={item.kind}>
                  {href ? <Link href={href}>{body}</Link> : body}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </DashboardPanel>
  );
}
