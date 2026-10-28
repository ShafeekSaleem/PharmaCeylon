"use client";

import { createContext, useContext } from "react";
import { webPosHidden, type PosRollout } from "@/lib/branch-rollout";

/**
 * W9 #71: no dashboard widget opens `/pos` at a live branch. The page provides the answer once
 * and the shared dashboard pieces (panel footers, quick actions, hero links, ticker, insights,
 * work queue) drop `/pos` links through it, so a widget can't reintroduce one by accident.
 */
export const PosHiddenContext = createContext(false);

export function usePosHidden(): boolean {
  return useContext(PosHiddenContext);
}

/** Unknown counts as hidden: the dashboard never offers the web POS before the branch is known. */
export function dashboardPosHidden(rollout: PosRollout | null): boolean {
  return rollout === null || webPosHidden(rollout);
}

export function isPosHref(href: string | null | undefined): boolean {
  return !!href && (href === "/pos" || href.startsWith("/pos?") || href.startsWith("/pos/"));
}

/** The link, or `undefined` when it would open the hidden web POS. */
export function dashboardHref(
  href: string | undefined,
  posHidden: boolean,
): string | undefined {
  return posHidden && isPosHref(href) ? undefined : href;
}
