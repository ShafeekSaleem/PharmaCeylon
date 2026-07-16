"use client";

import Link from "next/link";
import { useState } from "react";
import { IconChevronDown, IconChevronRight } from "@/components/icons";
import detailCss from "../product-detail.module.css";
import type { AuditHistoryItem, Product } from "../types";
import {
  formatAuditEventName,
  formatDateTime,
  summarizeAuditPayload,
} from "../utils/format";

function HistoryRow({ item }: { item: AuditHistoryItem }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeAuditPayload(item.payload);
  const hasPayload = item.payload !== null && item.payload !== undefined;

  return (
    <li className={detailCss.historyItem}>
      <div className={detailCss.historyHead}>
        <span className={detailCss.historyEvent}>{formatAuditEventName(item.eventName)}</span>
        <time className={detailCss.historyTime}>{formatDateTime(item.createdAt)}</time>
      </div>
      {item.actor && <span className={detailCss.historyActor}>by {item.actor.fullName}</span>}
      {summary && !expanded && <p className={detailCss.historySummary}>{summary}</p>}
      {hasPayload && (
        <button
          type="button"
          className={detailCss.historyToggle}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          {expanded ? "Hide details" : "Show details"}
        </button>
      )}
      {expanded && hasPayload && (
        <pre className={detailCss.historyPayload}>
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      )}
    </li>
  );
}

type Props = {
  product: Product;
  history: AuditHistoryItem[];
};

export function ProductDetailHistoryTab({ product, history }: Props) {
  return (
    <section className={detailCss.section}>
      <div className={detailCss.sectionHead}>
        <h2 className={detailCss.sectionTitle}>Recent changes</h2>
        {history.length > 0 && (
          <span className={detailCss.sectionCount}>{history.length} entries</span>
        )}
      </div>
      {history.length === 0 ? (
        <div className={detailCss.emptyState}>
          <p className={detailCss.muted}>No audit history recorded for this product yet.</p>
        </div>
      ) : (
        <ul className={detailCss.historyList}>
          {history.map((h) => (
            <HistoryRow key={h.id} item={h} />
          ))}
        </ul>
      )}
      <Link
        href={`/audit?entityName=product&entityId=${product.id}`}
        className={detailCss.footerLink}
      >
        View full audit log
        <IconChevronRight size={14} />
      </Link>
    </section>
  );
}
