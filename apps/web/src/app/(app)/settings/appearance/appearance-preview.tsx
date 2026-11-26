"use client";

import { ActionButton, StatusBadge } from "@/components/ui";
import { IconBarChart, IconBox, IconGrid, IconPackage } from "@/components/icons";
import page from "./appearance.module.css";

const NAV = [
  { label: "Dashboard", icon: <IconGrid size={14} />, active: true },
  { label: "Products", icon: <IconPackage size={14} /> },
  { label: "Inventory", icon: <IconBox size={14} /> },
  { label: "Reports", icon: <IconBarChart size={14} /> },
];

/** Seven days of sales, as bars in the chart colours, so a change of palette shows. */
const BARS = [52, 30, 68, 44, 84, 60, 38];

/**
 * Real components in the page's live appearance (UI1 #205): the sidebar style, buttons, status
 * chips, a link, chart colours and a checkbox. It reads the same tokens as every page, so it
 * shows the draft display and brand the page has applied, before anything is saved. It is a
 * picture: nothing in it acts, and none of it is in the tab order.
 */
export function AppearancePreview() {
  return (
    <aside className={page.preview} aria-labelledby="appearance-preview-title">
      <h2 className={page.previewTitle} id="appearance-preview-title">
        Preview
      </h2>
      <div className={page.previewBody} aria-hidden="true">
        <nav className={page.previewNav} aria-label="Sample navigation">
          {NAV.map((item) => (
            <span
              key={item.label}
              className={`${page.previewNavItem}${item.active ? ` ${page.previewNavActive}` : ""}`}
            >
              {item.icon}
              {item.label}
            </span>
          ))}
        </nav>
        <div className={page.previewMain}>
          <div className={page.previewRow}>
            <ActionButton tabIndex={-1} type="button">
              Approve order
            </ActionButton>
            <ActionButton tabIndex={-1} type="button" variant="secondary">
              Open receiving
            </ActionButton>
          </div>
          <div className={page.previewRow}>
            <StatusBadge status="late" label="3 days late" variant="danger" />
            <StatusBadge status="low" label="Low · 14" variant="warning" />
            <StatusBadge status="in_use" label="In use" variant="success" />
          </div>
          <p className={page.previewText}>
            Sales report:{" "}
            <a href="#appearance-preview-title" tabIndex={-1} onClick={(e) => e.preventDefault()}>
              last 30 days
            </a>
          </p>
          <div className={page.previewChart} role="img" aria-label="Sample bar chart">
            {BARS.map((height, i) => (
              <span
                key={i}
                style={{ height: `${height}%`, background: `var(--pc-chart-${(i % 6) + 1})` }}
              />
            ))}
          </div>
          <label className={page.previewCheck}>
            <input type="checkbox" checked readOnly tabIndex={-1} />
            Show counters no longer in use
          </label>
        </div>
      </div>
      <p className={page.previewFoot}>
        The counter app and the receipt header use the same accent.
      </p>
    </aside>
  );
}
