"use client";

import type { CSSProperties } from "react";
import Link from "next/link";

const linkStyle: CSSProperties = {
  color: "var(--pc-primary)",
  textDecoration: "none",
  fontSize: "0.95rem",
  fontWeight: 500,
};

export function PmsNav() {
  const links = [
    ["/dashboard", "Dashboard"],
    ["/products", "Products"],
    ["/suppliers", "Suppliers"],
    ["/users", "Users"],
    ["/purchasing", "Purchasing"],
    ["/pos", "POS"],
    ["/transfers", "Transfers"],
    ["/reports", "Reports"],
    ["/audit", "Audit"],
    ["/catalog", "Catalog"],
    ["/analytics", "Analytics"],
  ] as const;

  return (
    <nav
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.75rem 1rem",
        marginBottom: "1.25rem",
        paddingBottom: "1rem",
        borderBottom: "1px solid var(--pc-border)",
      }}
    >
      {links.map(([href, label]) => (
        <Link key={href} href={href} style={linkStyle}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
