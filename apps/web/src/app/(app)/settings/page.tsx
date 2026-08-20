"use client";

import Link from "next/link";
import { IconGrid, IconDollarSign } from "@/components/icons";

const SETTINGS_SECTIONS = [
  {
    href: "/settings/catalog/categories",
    title: "Catalog → Categories",
    description:
      "Manage commercial (merchandise) categories used by the Products page, POS, and reports — enable/disable departments, create custom categories, and reassign products.",
    icon: <IconGrid size={18} />,
  },
  {
    href: "/settings/profitability",
    title: "Profitability",
    description:
      "Set the tenant-wide gross margin % goal shown on Reports → Profitability → Gross Profit's goal tracker.",
    icon: <IconDollarSign size={18} />,
  },
];

export default function SettingsPage() {
  return (
    <div>
      <div
        style={{
          background: "var(--pc-card-bg)",
          borderRadius: "var(--pc-radius-md)",
          padding: "1.5rem",
          border: "1px solid var(--pc-border)",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem", fontWeight: 600 }}>Settings</h2>
        <p style={{ color: "var(--pc-muted-fg)", margin: 0 }}>
          Tenant-wide configuration for the catalog, taxonomy, and other application settings.
        </p>
      </div>

      <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {SETTINGS_SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            style={{
              display: "flex",
              gap: "0.75rem",
              padding: "1.1rem",
              background: "var(--pc-card-bg)",
              border: "1px solid var(--pc-border)",
              borderRadius: "var(--pc-radius-md)",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <span style={{ color: "var(--pc-primary)" }}>{section.icon}</span>
            <span>
              <span style={{ display: "block", fontWeight: 600, fontSize: "0.92rem" }}>{section.title}</span>
              <span style={{ display: "block", fontSize: "0.8rem", color: "var(--pc-muted-fg)", marginTop: "0.2rem" }}>
                {section.description}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
