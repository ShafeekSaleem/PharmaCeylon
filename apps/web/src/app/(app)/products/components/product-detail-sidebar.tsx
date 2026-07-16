"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconBox,
  IconClipboardList,
  IconFileText,
  IconGrid,
  IconPackage,
  IconShoppingCart,
  IconTruck,
} from "@/components/icons";
import detailCss from "../product-detail.module.css";
import type { ProductNavLink } from "../utils/product-routes";

const WORKFLOW_ICONS: Record<string, ReactNode> = {
  inventory: <IconPackage size={16} />,
  batches: <IconBox size={16} />,
  adjustments: <IconActivity size={16} />,
  purchasing: <IconClipboardList size={16} />,
  transfers: <IconTruck size={16} />,
  pos: <IconShoppingCart size={16} />,
  catalog: <IconGrid size={16} />,
  audit: <IconFileText size={16} />,
};

type Props = {
  navLinks: ProductNavLink[];
};

export function ProductDetailSidebar({ navLinks }: Props) {
  return (
    <aside className={detailCss.sidebar}>
      <div className={detailCss.sideCard}>
        <h3 className={detailCss.sideCardTitle}>Related workflows</h3>
        <nav className={detailCss.navGrid} aria-label="Product operations">
          {navLinks.map((link) => (
            <Link
              key={link.id}
              href={link.href}
              className={`${detailCss.navItem} ${!link.ready ? detailCss.navItemDisabled : ""}`}
            >
              <div className={detailCss.navItemHead}>
                <span className={detailCss.navItemLabelRow}>
                  <span className={detailCss.navItemIcon}>{WORKFLOW_ICONS[link.id]}</span>
                  {link.label}
                </span>
                <span
                  className={`${detailCss.navBadge} ${link.ready ? detailCss.navBadgeReady : ""}`}
                >
                  {link.ready ? "Open" : "Soon"}
                </span>
              </div>
              <p className={detailCss.navItemDesc}>{link.description}</p>
            </Link>
          ))}
        </nav>
      </div>
    </aside>
  );
}
