"use client";

import { createContext, useContext } from "react";

/**
 * The current page's display name, worked out by the shell from the route (and from a page's
 * `setLastSegmentLabel`, e.g. a product's name). The page header is the one place it is shown
 * (#205): the top bar no longer carries it, and the breadcrumb lists only the parents.
 */
const PageTitleContext = createContext<string | null>(null);

export const PageTitleProvider = PageTitleContext.Provider;

export function usePageTitle(): string | null {
  return useContext(PageTitleContext);
}
